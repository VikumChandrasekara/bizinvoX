//! Native PDF rendering (printpdf). Pure Rust, no headless browser: a typical
//! invoice renders in a few milliseconds on the blocking pool.
//!
//! Layout mirrors the frontend's live preview (same template JSON, same
//! sections), so what users see is what they download.
//!
//! Limitation: the 14 standard PDF fonts only cover Latin text, so other
//! scripts are transliterated or replaced. Embedding a Unicode TTF (e.g. Noto
//! Sans) via `add_external_font` removes that limit.

use image::{codecs::jpeg::JpegEncoder, ColorType, GenericImageView};
use image::{DynamicImage, Rgb as ImgRgb, RgbImage};
use printpdf::{
    BlendMode, SeperableBlendMode, BuiltinFont, Color, ColorBits, ColorSpace, Image, ImageFilter, ImageTransform, ImageXObject,
    IndirectFontRef, Line, Mm, PdfDocument, PdfDocumentReference, PdfLayerReference, Point, Pt, Px,
    Rect, Rgb, TextMatrix,
};
use rust_decimal::Decimal;

use crate::{
    invoice_calc,
    models::{Density, FontFamily, HeaderStyle, InvoiceRow, LogoPosition, Party, TemplateLayout},
};

pub struct RenderOptions {
    /// Small "Created with bizinvoX.com" footer (Guest/Free).
    pub branding_footer: bool,
    /// Small "bizinvoX.com" marks tiled all over the page (Guest/Free until the watermark is paid off).
    pub watermark: bool,
}

const WATERMARK_TEXT: &str = "bizinvoX.com";
/// Watermark tile: text size (pt), tilt (degrees) and spacing (mm). Mirrored in the frontend preview.
const WM_SIZE: f32 = 11.0;
const WM_ANGLE: f32 = 30.0;
const WM_PITCH_X: f32 = 52.0;
const WM_PITCH_Y: f32 = 24.0;

const W: f32 = 210.0;
const H: f32 = 297.0;
const M: f32 = 16.0;
const CONTENT_W: f32 = W - 2.0 * M;
const FOOTER_SPACE: f32 = 26.0;
const HEADER_H: f32 = 42.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rgbf(f32, f32, f32);

impl Rgbf {
    fn parse(hex: &str) -> Self {
        let h = hex.trim_start_matches('#');
        let c = |i: usize| {
            u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0
        };
        if h.len() == 6 {
            Rgbf(c(0), c(2), c(4))
        } else {
            Rgbf(0.0, 0.0, 0.0)
        }
    }
    fn color(self) -> Color {
        Color::Rgb(Rgb::new(self.0, self.1, self.2, None))
    }
    fn mix_white(self, t: f32) -> Self {
        Rgbf(
            self.0 + (1.0 - self.0) * t,
            self.1 + (1.0 - self.1) * t,
            self.2 + (1.0 - self.2) * t,
        )
    }
    fn luminance(self) -> f32 {
        0.2126 * self.0 + 0.7152 * self.1 + 0.0722 * self.2
    }
    /// Readable text colour on top of this background.
    fn on(self) -> Self {
        if self.luminance() > 0.55 {
            Rgbf(0.07, 0.09, 0.15)
        } else {
            WHITE
        }
    }
    fn to_u8(self) -> [u8; 3] {
        // Round (not truncate) so the flattened logo background matches the
        // header fill exactly and no faint box appears around the logo.
        [
            (self.0 * 255.0).round() as u8,
            (self.1 * 255.0).round() as u8,
            (self.2 * 255.0).round() as u8,
        ]
    }
}

const WHITE: Rgbf = Rgbf(1.0, 1.0, 1.0);
const MUTED: Rgbf = Rgbf(0.42, 0.45, 0.50);
const ZEBRA: Rgbf = Rgbf(0.965, 0.97, 0.98);
const RULE: Rgbf = Rgbf(0.86, 0.87, 0.90);
const WATERMARK: Rgbf = Rgbf(0.72, 0.75, 0.84);

struct Fonts {
    regular: IndirectFontRef,
    bold: IndirectFontRef,
    family: FontFamily,
}

impl Fonts {
    fn load(doc: &PdfDocumentReference, family: FontFamily) -> anyhow::Result<Self> {
        let (r, b) = match family {
            FontFamily::Helvetica => (BuiltinFont::Helvetica, BuiltinFont::HelveticaBold),
            FontFamily::Times => (BuiltinFont::TimesRoman, BuiltinFont::TimesBold),
            FontFamily::Courier => (BuiltinFont::Courier, BuiltinFont::CourierBold),
        };
        let load = |f| {
            doc.add_builtin_font(f)
                .map_err(|e| anyhow::anyhow!("font: {e:?}"))
        };
        Ok(Self {
            regular: load(r)?,
            bold: load(b)?,
            family,
        })
    }
    fn get(&self, bold: bool) -> &IndirectFontRef {
        if bold {
            &self.bold
        } else {
            &self.regular
        }
    }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/// Approximate advance width (em) for the standard fonts; good enough for
/// right-alignment and wrapping.
fn char_em(c: char, family: FontFamily, bold: bool) -> f32 {
    if family == FontFamily::Courier {
        return 0.6;
    }
    let base = match c {
        'i' | 'j' | 'l' | '.' | ',' | ':' | ';' | '\'' | '|' | '!' | ' ' => 0.278,
        'f' | 't' | 'r' | 'I' | '(' | ')' | '[' | ']' | '-' | '/' => 0.333,
        '0'..='9' | '$' | '#' | '?' | '_' | '*' => 0.556,
        'm' | 'M' => 0.833,
        'w' | 'W' => 0.8,
        '%' => 0.889,
        'A'..='Z' => 0.667,
        _ => 0.54,
    };
    let base = if family == FontFamily::Times {
        base * 0.92
    } else {
        base
    };
    if bold {
        base * 1.06
    } else {
        base
    }
}

const PT_TO_MM: f32 = 0.352_778;

fn text_width(s: &str, size: f32, family: FontFamily, bold: bool) -> f32 {
    s.chars().map(|c| char_em(c, family, bold)).sum::<f32>() * size * PT_TO_MM
}

fn wrap(text: &str, max_w: f32, size: f32, family: FontFamily, bold: bool) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in pdf_safe(text).split('\n') {
        let mut current = String::new();
        for word in paragraph.split_whitespace() {
            let candidate = if current.is_empty() {
                word.to_owned()
            } else {
                format!("{current} {word}")
            };
            if text_width(&candidate, size, family, bold) <= max_w {
                current = candidate;
                continue;
            }
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            // Hard-break words that are longer than a full line.
            let mut chunk = String::new();
            for ch in word.chars() {
                chunk.push(ch);
                if text_width(&chunk, size, family, bold) > max_w {
                    chunk.pop();
                    lines.push(std::mem::take(&mut chunk));
                    chunk.push(ch);
                }
            }
            current = chunk;
        }
        lines.push(current);
    }
    while lines.last().is_some_and(String::is_empty) && lines.len() > 1 {
        lines.pop();
    }
    lines
}

fn truncate_to(s: &str, max_w: f32, size: f32, family: FontFamily, bold: bool) -> String {
    if text_width(s, size, family, bold) <= max_w {
        return s.to_owned();
    }
    let mut out = String::new();
    for ch in s.chars() {
        out.push(ch);
        if text_width(&format!("{out}..."), size, family, bold) > max_w {
            out.pop();
            break;
        }
    }
    format!("{out}...")
}

/// Map text onto the WinAnsi-safe subset supported by the standard fonts.
pub fn pdf_safe(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' '..='~' | '\n' => out.push(c),
            '\r' => {}
            '\t' | '\u{00A0}' => out.push(' '),
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{2032}' => out.push('\''),
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{2033}' => out.push('"'),
            '\u{2013}' | '\u{2014}' | '\u{2212}' => out.push('-'),
            '\u{2026}' => out.push_str("..."),
            '\u{20AC}' => out.push_str("EUR "),
            '\u{00A3}' => out.push_str("GBP "),
            '\u{00A5}' => out.push_str("JPY "),
            '\u{00DF}' => out.push_str("ss"),
            c => out.push(fold_latin(c)),
        }
    }
    out
}

fn fold_latin(c: char) -> char {
    const MAP: &[(&str, char)] = &[
        ("ÀÁÂÃÄÅĀĂĄ", 'A'),
        ("àáâãäåāăą", 'a'),
        ("ÇĆĈĊČ", 'C'),
        ("çćĉċč", 'c'),
        ("ĎĐ", 'D'),
        ("ďđ", 'd'),
        ("ÈÉÊËĒĔĖĘĚ", 'E'),
        ("èéêëēĕėęě", 'e'),
        ("ĜĞĠĢ", 'G'),
        ("ĝğġģ", 'g'),
        ("ÌÍÎÏĪĬĮİ", 'I'),
        ("ìíîïīĭįı", 'i'),
        ("ĹĻĽĿŁ", 'L'),
        ("ĺļľŀł", 'l'),
        ("ÑŃŅŇ", 'N'),
        ("ñńņň", 'n'),
        ("ÒÓÔÕÖØŌŎŐ", 'O'),
        ("òóôõöøōŏő", 'o'),
        ("ŔŖŘ", 'R'),
        ("ŕŗř", 'r'),
        ("ŚŜŞŠ", 'S'),
        ("śŝşš", 's'),
        ("ŢŤ", 'T'),
        ("ţť", 't'),
        ("ÙÚÛÜŨŪŬŮŰŲ", 'U'),
        ("ùúûüũūŭůűų", 'u'),
        ("ÝŸ", 'Y'),
        ("ýÿ", 'y'),
        ("ŹŻŽ", 'Z'),
        ("źżž", 'z'),
    ];
    MAP.iter()
        .find(|(set, _)| set.contains(c))
        .map_or('?', |(_, r)| *r)
}

pub fn format_amount(d: Decimal) -> String {
    let d = d.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero);
    let negative = d.is_sign_negative() && !d.is_zero();
    let s = format!("{:.2}", d.abs());
    let (int, frac) = s.split_once('.').unwrap_or((&s, "00"));
    let mut grouped = String::with_capacity(int.len() + int.len() / 3);
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{}{grouped}.{frac}", if negative { "-" } else { "" })
}

pub fn money(d: Decimal, currency: &str) -> String {
    let amount = format_amount(d);
    match currency {
        "USD" => format!("${amount}"),
        "CAD" => format!("CA${amount}"),
        "AUD" => format!("A${amount}"),
        "NZD" => format!("NZ${amount}"),
        "SGD" => format!("S${amount}"),
        "HKD" => format!("HK${amount}"),
        "MXN" => format!("MX${amount}"),
        other => format!("{other} {amount}"),
    }
}

fn fmt_rate(d: Decimal) -> String {
    format!("{}%", d.normalize())
}

fn fmt_date(d: chrono::NaiveDate) -> String {
    d.format("%b %d, %Y").to_string()
}

// ---------------------------------------------------------------------------
// Drawing context
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    doc: &'a PdfDocumentReference,
    fonts: Fonts,
    layers: Vec<PdfLayerReference>,
    y: f32,
    layout: &'a TemplateLayout,
    primary: Rgbf,
    accent: Rgbf,
    text: Rgbf,
}

/// Small "bizinvoX.com" marks tiled over the whole page in staggered rows. Drawn last, on top of the
/// invoice, with a multiply blend so text underneath stays readable. Because it is a dense pattern
/// over the content (not one object behind it), it can't be removed by deleting a single element
/// or by hiding a background layer. The frontend preview uses the same size, angle and spacing.
fn draw_watermark(layer: &PdfLayerReference, font: &IndirectFontRef, family: FontFamily) {
    let width = text_width(WATERMARK_TEXT, WM_SIZE, family, true);
    layer.save_graphics_state();
    layer.set_blend_mode(BlendMode::Seperable(SeperableBlendMode::Multiply));
    layer.set_fill_color(WATERMARK.color());
    let mut y = WM_PITCH_Y / 2.0;
    let mut row = 0u32;
    while y < H + WM_PITCH_Y {
        // Every other row is shifted by half a pitch. Start off-page so the rotated tiles reach the edges.
        let shift = if row % 2 == 0 { 0.0 } else { WM_PITCH_X / 2.0 };
        let mut x = -width - WM_PITCH_X + shift;
        while x < W + WM_PITCH_X {
            layer.begin_text_section();
            layer.set_font(font, WM_SIZE);
            layer.set_text_matrix(TextMatrix::TranslateRotate(
                Pt::from(Mm(x)),
                Pt::from(Mm(y)),
                WM_ANGLE,
            ));
            layer.write_text(WATERMARK_TEXT, font);
            layer.end_text_section();
            x += WM_PITCH_X;
        }
        y += WM_PITCH_Y;
        row += 1;
    }
    layer.restore_graphics_state();
}

fn draw_text(
    layer: &PdfLayerReference,
    font: &IndirectFontRef,
    x: f32,
    baseline: f32,
    s: &str,
    size: f32,
    color: Rgbf,
) {
    layer.set_fill_color(color.color());
    layer.use_text(pdf_safe(s), size, Mm(x), Mm(H - baseline), font);
}

fn fill_rect(layer: &PdfLayerReference, x: f32, top: f32, w: f32, h: f32, color: Rgbf) {
    layer.set_fill_color(color.color());
    layer.add_rect(Rect::new(Mm(x), Mm(H - top - h), Mm(x + w), Mm(H - top)));
}

fn hline(layer: &PdfLayerReference, x1: f32, x2: f32, y: f32, color: Rgbf, thickness_pt: f32) {
    layer.set_outline_color(color.color());
    layer.set_outline_thickness(thickness_pt);
    layer.add_line(Line {
        points: vec![
            (Point::new(Mm(x1), Mm(H - y)), false),
            (Point::new(Mm(x2), Mm(H - y)), false),
        ],
        is_closed: false,
    });
}

#[derive(Clone, Copy, PartialEq)]
enum ColKind {
    Description,
    Quantity,
    Price,
    Tax,
    Discount,
    Amount,
}

struct Col {
    kind: ColKind,
    title: &'static str,
    width: f32,
}

impl<'a> Ctx<'a> {
    fn layer(&self) -> &PdfLayerReference {
        self.layers.last().expect("at least one page")
    }

    fn text(&self, x: f32, baseline: f32, s: &str, size: f32, bold: bool, color: Rgbf) {
        draw_text(
            self.layer(),
            self.fonts.get(bold),
            x,
            baseline,
            s,
            size,
            color,
        );
    }

    fn text_right(&self, right: f32, baseline: f32, s: &str, size: f32, bold: bool, color: Rgbf) {
        let w = text_width(&pdf_safe(s), size, self.fonts.family, bold);
        self.text(right - w, baseline, s, size, bold, color);
    }

    fn width(&self, s: &str, size: f32, bold: bool) -> f32 {
        text_width(s, size, self.fonts.family, bold)
    }

    fn new_page(&mut self) {
        let (page, layer) = self.doc.add_page(Mm(W), Mm(H), "content");
        self.layers.push(self.doc.get_page(page).get_layer(layer));
        self.y = M;
    }

    /// Starts a new page if `needed` mm don't fit. Returns true if it did.
    fn ensure_space(&mut self, needed: f32) -> bool {
        if self.y + needed > H - FOOTER_SPACE {
            self.new_page();
            true
        } else {
            false
        }
    }

    // -- header ---------------------------------------------------------------

    fn header(&mut self, inv: &InvoiceRow, logo: Option<&DynamicImage>) {
        let l = self.layout;
        let (background, title_color, sub_color) = match l.header_style {
            HeaderStyle::Band => {
                fill_rect(self.layer(), 0.0, 0.0, W, HEADER_H, self.primary);
                (self.primary, self.primary.on(), self.primary.on())
            }
            HeaderStyle::Tinted => {
                let tint = self.primary.mix_white(0.9);
                fill_rect(self.layer(), 0.0, 0.0, W, HEADER_H, tint);
                (tint, self.primary, self.text)
            }
            HeaderStyle::Minimal => (WHITE, self.primary, self.text),
        };

        let title = match l.title_text.trim() {
            "" => "INVOICE",
            t => t,
        };
        let number = format!("No. {}", inv.invoice_number);
        let business = inv.business_info.name.trim();

        let logo_left = logo.is_some() && l.logo_position == LogoPosition::Left;
        let logo_right = logo.is_some() && l.logo_position == LogoPosition::Right;

        let show_number = !l.hides("header.number");
        if logo_left {
            self.text_right(W - M, 21.0, title, 24.0, true, title_color);
            if show_number {
                self.text_right(W - M, 29.0, &number, 10.0, false, sub_color);
            }
        } else {
            self.text(M, 21.0, title, 24.0, true, title_color);
            if show_number {
                self.text(M, 29.0, &number, 10.0, false, sub_color);
            }
        }

        if let Some(img) = logo.filter(|_| logo_left || logo_right) {
            let x_anchor = if logo_left { M } else { W - M };
            self.place_logo(img, background, x_anchor, logo_left);
        } else if !business.is_empty() {
            let name = truncate_to(business, 80.0, 13.0, self.fonts.family, true);
            self.text_right(W - M, 21.0, &name, 13.0, true, title_color);
        }

        match l.header_style {
            HeaderStyle::Minimal => hline(self.layer(), M, W - M, HEADER_H - 3.0, self.accent, 2.0),
            _ => fill_rect(self.layer(), 0.0, HEADER_H, W, 1.4, self.accent),
        }
        self.y = HEADER_H + 13.0;
    }

    fn place_logo(
        &self,
        img: &DynamicImage,
        background: Rgbf,
        x_anchor: f32,
        anchor_is_left: bool,
    ) {
        const DPI: f32 = 300.0;
        // Never embed more pixels than the 48x22 mm logo box can show at 300 dpi.
        let (max_w, max_h) = ((48.0 / 25.4 * DPI) as u32, (22.0 / 25.4 * DPI) as u32);
        let (src_w, src_h) = img.dimensions();
        let resized;
        let img = if src_w > max_w || src_h > max_h {
            resized = img.thumbnail(max_w, max_h);
            &resized
        } else {
            img
        };
        let flattened = flatten_onto(img, background);
        let (px_w, px_h) = flattened.dimensions();
        let natural_w = px_w as f32 * 25.4 / DPI;
        let natural_h = px_h as f32 * 25.4 / DPI;
        let scale = (48.0 / natural_w).min(22.0 / natural_h).min(3.0);
        let (w, h) = (natural_w * scale, natural_h * scale);
        let x = if anchor_is_left {
            x_anchor
        } else {
            x_anchor - w
        };
        let top = (HEADER_H - h) / 2.0;
        // printpdf stores raw pixels uncompressed; embed as JPEG (DCT) instead,
        // which keeps a logo to a few KB rather than hundreds.
        let mut jpeg = Vec::new();
        if JpegEncoder::new_with_quality(&mut jpeg, 92)
            .encode(flattened.as_raw(), px_w, px_h, ColorType::Rgb8)
            .is_err()
        {
            return;
        }
        let xobject = ImageXObject {
            width: Px(px_w as usize),
            height: Px(px_h as usize),
            color_space: ColorSpace::Rgb,
            bits_per_component: ColorBits::Bit8,
            interpolate: true,
            image_data: jpeg,
            image_filter: Some(ImageFilter::DCT),
            smask: None,
            clipping_bbox: None,
        };
        Image::from(xobject).add_to_layer(
            self.layer().clone(),
            ImageTransform {
                translate_x: Some(Mm(x)),
                translate_y: Some(Mm(H - top - h)),
                scale_x: Some(scale),
                scale_y: Some(scale),
                dpi: Some(DPI),
                ..Default::default()
            },
        );
    }

    // -- parties + details ----------------------------------------------------

    fn parties(&mut self, inv: &InvoiceRow) {
        let gap = 7.0;
        let col_w = (CONTENT_W - 2.0 * gap) / 3.0;
        let x1 = M;
        let x2 = M + col_w + gap;
        let x3 = x2 + col_w + gap;
        let start = self.y;
        let h1 = self.party_block(x1, start, col_w, "FROM", "business", &inv.business_info);
        let h2 = self.party_block(x2, start, col_w, "BILL TO", "client", &inv.client_info);
        let h3 = self.details_block(x3, start, col_w, inv);
        self.y = start + h1.max(h2).max(h3) + 9.0;
    }

    fn party_block(&self, x: f32, y0: f32, w: f32, label: &str, side: &str, p: &Party) -> f32 {
        let fam = self.fonts.family;
        let mut y = y0;
        self.text(x, y, label, 7.5, true, self.primary);
        y += 5.6;
        for line in wrap(&p.name, w, 11.0, fam, true)
            .iter()
            .filter(|l| !l.is_empty())
        {
            self.text(x, y, line, 11.0, true, self.text);
            y += 5.0;
        }
        let detail = |value: &str, y: &mut f32| {
            for line in wrap(value, w, 9.0, fam, false)
                .iter()
                .filter(|l| !l.is_empty())
            {
                self.text(x, *y, line, 9.0, false, MUTED);
                *y += 4.3;
            }
        };
        let shown = |field: &str| !self.layout.hides(&format!("{side}.{field}"));
        if shown("address") {
            detail(&p.address, &mut y);
        }
        if shown("email") {
            detail(&p.email, &mut y);
        }
        if shown("phone") {
            detail(&p.phone, &mut y);
        }
        if shown("taxId") && !p.tax_id.is_empty() {
            detail(&format!("Tax ID: {}", p.tax_id), &mut y);
        }
        y - y0
    }

    fn details_block(&self, x: f32, y0: f32, w: f32, inv: &InvoiceRow) -> f32 {
        let l = self.layout;
        let mut rows: Vec<(String, String)> = Vec::new();
        if !l.hides("detail.invoiceNumber") {
            rows.push(("Invoice #".into(), inv.invoice_number.clone()));
        }
        if !l.hides("detail.issueDate") {
            rows.push(("Issue date".into(), fmt_date(inv.issue_date)));
        }
        if let Some(due) = inv.due_date.filter(|_| !l.hides("detail.dueDate")) {
            rows.push(("Due date".into(), fmt_date(due)));
        }
        if !l.hides("detail.currency") {
            rows.push(("Currency".into(), inv.currency.clone()));
        }
        for f in &self.layout.custom_fields {
            rows.push((f.label.clone(), f.value.clone()));
        }

        let mut y = y0;
        self.text(x, y, "DETAILS", 7.5, true, self.primary);
        y += 5.6;
        for (label, value) in rows {
            let label = truncate_to(&pdf_safe(&label), w * 0.45, 9.0, self.fonts.family, false);
            let value_w = w - self.width(&label, 9.0, false) - 3.0;
            let value = truncate_to(
                &pdf_safe(&value),
                value_w.max(10.0),
                9.0,
                self.fonts.family,
                true,
            );
            self.text(x, y, &label, 9.0, false, MUTED);
            self.text_right(x + w, y, &value, 9.0, true, self.text);
            y += 4.8;
        }
        y - y0
    }

    // -- line items -------------------------------------------------------------

    fn columns(&self) -> Vec<Col> {
        let mut fixed = vec![
            Col {
                kind: ColKind::Quantity,
                title: "QTY",
                width: 16.0,
            },
            Col {
                kind: ColKind::Price,
                title: "UNIT PRICE",
                width: 29.0,
            },
        ];
        if self.layout.show_tax_column {
            fixed.push(Col {
                kind: ColKind::Tax,
                title: "TAX",
                width: 15.0,
            });
        }
        if self.layout.show_discount_column {
            fixed.push(Col {
                kind: ColKind::Discount,
                title: "DISC.",
                width: 15.0,
            });
        }
        fixed.push(Col {
            kind: ColKind::Amount,
            title: "AMOUNT",
            width: 31.0,
        });
        let used: f32 = fixed.iter().map(|c| c.width).sum();
        let mut cols = vec![Col {
            kind: ColKind::Description,
            title: "DESCRIPTION",
            width: CONTENT_W - used,
        }];
        cols.extend(fixed);
        cols
    }

    fn table_header(&mut self, cols: &[Col]) {
        let h = 8.0;
        fill_rect(self.layer(), M, self.y, CONTENT_W, h, self.primary);
        let fg = self.primary.on();
        let mut x = M;
        for c in cols {
            if c.kind == ColKind::Description {
                self.text(x + 3.0, self.y + 5.4, c.title, 7.5, true, fg);
            } else {
                self.text_right(x + c.width - 3.0, self.y + 5.4, c.title, 7.5, true, fg);
            }
            x += c.width;
        }
        self.y += h;
    }

    fn items(&mut self, inv: &InvoiceRow) {
        let cols = self.columns();
        let desc_w = cols[0].width - 6.0;
        let pad = match self.layout.density {
            Density::Compact => 2.0,
            Density::Comfortable => 3.2,
        };
        let size = 9.0;
        let lh = 4.4;

        self.ensure_space(22.0);
        self.table_header(&cols);

        for (i, item) in inv.line_items.iter().enumerate() {
            let lines = wrap(&item.description, desc_w, size, self.fonts.family, false);
            let row_h = pad * 2.0 + lh * lines.len() as f32;
            if self.ensure_space(row_h) {
                self.table_header(&cols);
            }
            if i % 2 == 1 {
                fill_rect(self.layer(), M, self.y, CONTENT_W, row_h, ZEBRA);
            }
            let b = invoice_calc::breakdown(item);
            let baseline = self.y + pad + lh * 0.78;
            let mut x = M;
            for c in &cols {
                let right = x + c.width - 3.0;
                match c.kind {
                    ColKind::Description => {
                        for (n, line) in lines.iter().enumerate() {
                            self.text(
                                x + 3.0,
                                baseline + n as f32 * lh,
                                line,
                                size,
                                false,
                                self.text,
                            );
                        }
                    }
                    ColKind::Quantity => self.text_right(
                        right,
                        baseline,
                        &item.quantity.normalize().to_string(),
                        size,
                        false,
                        self.text,
                    ),
                    ColKind::Price => self.text_right(
                        right,
                        baseline,
                        &format_amount(item.unit_price),
                        size,
                        false,
                        self.text,
                    ),
                    ColKind::Tax => self.text_right(
                        right,
                        baseline,
                        &fmt_rate(item.tax_rate),
                        size,
                        false,
                        MUTED,
                    ),
                    ColKind::Discount => self.text_right(
                        right,
                        baseline,
                        &fmt_rate(item.discount_rate),
                        size,
                        false,
                        MUTED,
                    ),
                    ColKind::Amount => self.text_right(
                        right,
                        baseline,
                        &format_amount(b.amount),
                        size,
                        true,
                        self.text,
                    ),
                }
                x += c.width;
            }
            self.y += row_h;
        }
        hline(self.layer(), M, W - M, self.y, RULE, 0.6);
        self.y += 7.0;
    }

    // -- totals + notes -------------------------------------------------------------

    fn totals_and_notes(&mut self, inv: &InvoiceRow) {
        let cur = inv.currency.as_str();
        let totals_w = 80.0;
        let tx = W - M - totals_w;

        let mut rows = vec![("Subtotal", money(inv.subtotal, cur))];
        if !inv.discount_total.is_zero() {
            rows.push(("Discount", format!("-{}", money(inv.discount_total, cur))));
        }
        if !inv.tax_total.is_zero() || self.layout.show_tax_column {
            rows.push(("Tax", money(inv.tax_total, cur)));
        }
        let needed = rows.len() as f32 * 6.4 + 16.0;
        self.ensure_space(needed);

        let start = self.y;
        let mut y = start;
        for (label, value) in &rows {
            self.text(tx + 4.0, y + 4.2, label, 9.5, false, MUTED);
            self.text_right(W - M - 3.0, y + 4.2, value, 9.5, false, self.text);
            y += 6.4;
        }
        y += 1.5;
        fill_rect(
            self.layer(),
            tx,
            y,
            totals_w,
            12.0,
            self.primary.mix_white(0.9),
        );
        fill_rect(self.layer(), tx, y, 1.6, 12.0, self.accent);
        self.text(tx + 5.0, y + 7.6, "Total due", 10.5, true, self.primary);
        self.text_right(
            W - M - 3.0,
            y + 7.8,
            &money(inv.grand_total, cur),
            13.0,
            true,
            self.primary,
        );
        let totals_end = y + 12.0;

        // Notes and payment terms flow down the left column (and onto new pages).
        let notes_w = CONTENT_W - totals_w - 10.0;
        let pages_before = self.layers.len();
        let mut ny = start;
        let sections = [
            ("PAYMENT TERMS", inv.payment_terms.as_deref().unwrap_or("")),
            ("NOTES", inv.notes.as_deref().unwrap_or("")),
        ];
        let hidden = |label: &str| {
            self.layout.hides(if label == "NOTES" {
                "notes"
            } else {
                "paymentTerms"
            })
        };
        for (label, body) in sections
            .iter()
            .filter(|(l, b)| !b.trim().is_empty() && !hidden(l))
        {
            if ny + 10.0 > H - FOOTER_SPACE {
                self.new_page();
                ny = M;
            }
            self.text(M, ny + 4.0, label, 7.5, true, self.primary);
            ny += 9.0;
            for line in wrap(body, notes_w, 9.0, self.fonts.family, false) {
                if ny > H - FOOTER_SPACE {
                    self.new_page();
                    ny = M + 4.0;
                }
                self.text(M, ny, &line, 9.0, false, self.text);
                ny += 4.4;
            }
            ny += 4.0;
        }
        self.y = if self.layers.len() > pages_before {
            ny
        } else {
            totals_end.max(ny)
        };
    }

    // -- per-page chrome ------------------------------------------------------------

    fn finish_pages(&self, opts: &RenderOptions) {
        let total = self.layers.len();
        let footer = if self.layout.hides("footer") {
            ""
        } else {
            self.layout.footer_text.trim()
        };
        for (i, layer) in self.layers.iter().enumerate() {
            if opts.watermark {
                // Last thing drawn on the page content, so it overlays everything above it.
                draw_watermark(layer, &self.fonts.bold, self.fonts.family);
            }
            hline(layer, M, W - M, H - 19.0, RULE, 0.5);
            if !footer.is_empty() {
                let text = truncate_to(
                    &pdf_safe(footer),
                    CONTENT_W - 30.0,
                    8.5,
                    self.fonts.family,
                    false,
                );
                let w = text_width(&text, 8.5, self.fonts.family, false);
                draw_text(
                    layer,
                    &self.fonts.regular,
                    (W - w) / 2.0,
                    H - 13.0,
                    &text,
                    8.5,
                    MUTED,
                );
            }
            if opts.branding_footer {
                let brand = "Created with bizinvoX.com";
                let w = text_width(brand, 7.0, self.fonts.family, false);
                draw_text(
                    layer,
                    &self.fonts.regular,
                    (W - w) / 2.0,
                    H - 8.0,
                    brand,
                    7.0,
                    MUTED.mix_white(0.25),
                );
            }
            if total > 1 {
                let label = format!("Page {} of {}", i + 1, total);
                let w = text_width(&label, 7.5, self.fonts.family, false);
                draw_text(
                    layer,
                    &self.fonts.regular,
                    W - M - w,
                    H - 8.0,
                    &label,
                    7.5,
                    MUTED,
                );
            }
        }
    }
}

/// Composite transparent logos onto the header background (PDF images here are RGB).
fn flatten_onto(img: &DynamicImage, bg: Rgbf) -> RgbImage {
    let rgba = img.to_rgba8();
    let [br, bg_, bb] = bg.to_u8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = px[3] as f32 / 255.0;
        let mix = |c: u8, b: u8| (c as f32 * a + b as f32 * (1.0 - a)).round() as u8;
        out.put_pixel(
            x,
            y,
            ImgRgb([mix(px[0], br), mix(px[1], bg_), mix(px[2], bb)]),
        );
    }
    out
}

pub fn render(
    inv: &InvoiceRow,
    layout: &TemplateLayout,
    logo_png: Option<&[u8]>,
    opts: &RenderOptions,
) -> anyhow::Result<Vec<u8>> {
    let title = pdf_safe(&format!("Invoice {}", inv.invoice_number));
    let (doc, page, layer) = PdfDocument::new(title, Mm(W), Mm(H), "content");
    let logo = logo_png.and_then(|bytes| image::load_from_memory(bytes).ok());
    {
        let fonts = Fonts::load(&doc, layout.font)?;
        let first = doc.get_page(page).get_layer(layer);
        let mut ctx = Ctx {
            doc: &doc,
            fonts,
            layers: vec![first],
            y: 0.0,
            layout,
            primary: Rgbf::parse(&layout.primary_color),
            accent: Rgbf::parse(&layout.accent_color),
            text: Rgbf::parse(&layout.text_color),
        };
        ctx.header(inv, logo.as_ref());
        ctx.parties(inv);
        ctx.items(inv);
        ctx.totals_and_notes(inv);
        ctx.finish_pages(opts);
    }
    doc.save_to_bytes()
        .map_err(|e| anyhow::anyhow!("pdf save: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{invoice_calc::LineItem, models::InvoiceStatus};
    use chrono::{NaiveDate, Utc};
    use sqlx::types::Json;
    use std::str::FromStr;
    use uuid::Uuid;

    fn sample(lines: usize) -> InvoiceRow {
        let items: Vec<LineItem> = (0..lines)
            .map(|i| LineItem {
                description: format!(
                    "Consulting work package {i} - discovery, café workshop & “strategy”"
                ),
                quantity: Decimal::from_str("2.5").unwrap(),
                unit_price: Decimal::from_str("120.00").unwrap(),
                tax_rate: Decimal::from_str("8").unwrap(),
                discount_rate: Decimal::ZERO,
            })
            .collect();
        let totals = invoice_calc::compute(&items).unwrap();
        InvoiceRow {
            id: Uuid::new_v4(),
            user_id: None,
            template_id: Uuid::from_u128(1),
            guest_token: None,
            status: InvoiceStatus::Draft,
            invoice_number: "INV-0042".into(),
            issue_date: NaiveDate::from_ymd_opt(2026, 11, 22).unwrap(),
            due_date: NaiveDate::from_ymd_opt(2026, 12, 22),
            currency: "USD".into(),
            business_info: Json(Party {
                name: "Acme Studio".into(),
                email: "billing@acme.test".into(),
                ..Default::default()
            }),
            client_info: Json(Party {
                name: "Globex Corp".into(),
                address: "1 Main St\nSpringfield".into(),
                ..Default::default()
            }),
            line_items: Json(items),
            subtotal: totals.subtotal,
            tax_total: totals.tax_total,
            discount_total: totals.discount_total,
            grand_total: totals.grand_total,
            notes: Some("Thanks!".into()),
            payment_terms: Some("Net 30".into()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            layout_json: None,
            has_logo: false,
            downloaded_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn renders_single_and_multi_page_pdfs() {
        let opts = RenderOptions {
            branding_footer: true,
            watermark: true,
        };
        let one = render(&sample(3), &TemplateLayout::default(), None, &opts).unwrap();
        assert!(one.starts_with(b"%PDF"));
        let many = render(&sample(60), &TemplateLayout::default(), None, &opts).unwrap();
        assert!(many.len() > one.len());
    }

    #[test]
    fn money_formatting() {
        assert_eq!(
            money(Decimal::from_str("1234567.5").unwrap(), "USD"),
            "$1,234,567.50"
        );
        assert_eq!(money(Decimal::from_str("12").unwrap(), "EUR"), "EUR 12.00");
        assert_eq!(format_amount(Decimal::from_str("-5.005").unwrap()), "-5.01");
    }

    #[test]
    fn text_is_made_pdf_safe() {
        assert_eq!(pdf_safe("José – “Café”"), "Jose - \"Cafe\"");
    }

    #[test]
    fn logos_are_embedded_compactly() {
        let mut logo = image::RgbaImage::new(800, 400);
        for (x, y, px) in logo.enumerate_pixels_mut() {
            *px = image::Rgba([
                (x % 256) as u8,
                (y % 256) as u8,
                140,
                if x < 400 { 255 } else { 90 },
            ]);
        }
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(logo)
            .write_to(&mut png, image::ImageOutputFormat::Png)
            .unwrap();
        let layout = TemplateLayout {
            logo_position: LogoPosition::Right,
            ..TemplateLayout::default()
        };
        let opts = RenderOptions {
            branding_footer: false,
            watermark: false,
        };
        let pdf = render(&sample(3), &layout, Some(&png.into_inner()), &opts).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.len() < 150_000, "PDF with logo is {} bytes", pdf.len());
    }
}
