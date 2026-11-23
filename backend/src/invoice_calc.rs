//! Server-authoritative invoice arithmetic. Fixed-point decimals only, never
//! floats. The frontend mirrors these exact rules for its live preview.
//!
//! Per line:
//!   net      = round2(quantity * unit_price)
//!   discount = round2(net * discount_rate / 100)
//!   tax      = round2((net - discount) * tax_rate / 100)
//!   amount   = net - discount + tax
//! Totals are the sums of the per-line values.

use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LineItem {
    #[validate(length(min = 1, max = 500))]
    pub description: String,
    #[schema(value_type = String, example = "2")]
    pub quantity: Decimal,
    #[schema(value_type = String, example = "150.00")]
    pub unit_price: Decimal,
    /// Percentage, 0-100.
    #[serde(default)]
    #[schema(value_type = String, example = "8")]
    pub tax_rate: Decimal,
    /// Percentage, 0-100.
    #[serde(default)]
    #[schema(value_type = String, example = "0")]
    pub discount_rate: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineBreakdown {
    pub net: Decimal,
    pub discount: Decimal,
    pub tax: Decimal,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Totals {
    pub subtotal: Decimal,
    pub discount_total: Decimal,
    pub tax_total: Decimal,
    pub grand_total: Decimal,
}

fn round2(d: Decimal) -> Decimal {
    d.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

pub fn breakdown(item: &LineItem) -> LineBreakdown {
    let hundred = Decimal::ONE_HUNDRED;
    let net = round2(item.quantity * item.unit_price);
    let discount = round2(net * item.discount_rate / hundred);
    let tax = round2((net - discount) * item.tax_rate / hundred);
    LineBreakdown {
        net,
        discount,
        tax,
        amount: net - discount + tax,
    }
}

/// numeric(12,2) upper bound.
fn max_money() -> Decimal {
    Decimal::new(999_999_999_999, 2)
}

pub fn compute(items: &[LineItem]) -> Result<Totals, AppError> {
    let hundred = Decimal::ONE_HUNDRED;
    let mut t = Totals::default();
    for (i, item) in items.iter().enumerate() {
        let n = i + 1;
        if item.quantity < Decimal::ZERO || item.quantity > Decimal::new(1_000_000, 0) {
            return Err(AppError::validation(format!(
                "Line {n}: quantity must be between 0 and 1,000,000."
            )));
        }
        if item.quantity.scale() > 4 {
            return Err(AppError::validation(format!(
                "Line {n}: quantity supports at most 4 decimal places."
            )));
        }
        if item.unit_price < Decimal::ZERO || item.unit_price > Decimal::new(100_000_000, 0) {
            return Err(AppError::validation(format!(
                "Line {n}: unit price must be between 0 and 100,000,000."
            )));
        }
        if item.unit_price.scale() > 2 {
            return Err(AppError::validation(format!(
                "Line {n}: unit price supports at most 2 decimal places."
            )));
        }
        for (label, rate) in [
            ("tax rate", item.tax_rate),
            ("discount", item.discount_rate),
        ] {
            if rate < Decimal::ZERO || rate > hundred || rate.scale() > 3 {
                return Err(AppError::validation(format!(
                    "Line {n}: {label} must be a percentage between 0 and 100."
                )));
            }
        }
        let b = breakdown(item);
        t.subtotal += b.net;
        t.discount_total += b.discount;
        t.tax_total += b.tax;
        t.grand_total += b.amount;
    }
    if t.subtotal > max_money() || t.grand_total > max_money() {
        return Err(AppError::validation("Invoice total is too large."));
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn item(q: &str, p: &str, tax: &str, disc: &str) -> LineItem {
        LineItem {
            description: "x".into(),
            quantity: d(q),
            unit_price: d(p),
            tax_rate: d(tax),
            discount_rate: d(disc),
        }
    }

    #[test]
    fn computes_totals_with_tax_and_discount() {
        let items = vec![
            item("2", "150.00", "8", "10"),
            item("1.5", "19.99", "0", "0"),
        ];
        let t = compute(&items).unwrap();
        // line 1: net 300, disc 30, tax 21.60, amount 291.60
        // line 2: net 29.985 -> 29.99 (half away from zero), amount 29.99
        assert_eq!(t.subtotal, d("329.99"));
        assert_eq!(t.discount_total, d("30.00"));
        assert_eq!(t.tax_total, d("21.60"));
        assert_eq!(t.grand_total, d("321.59"));
    }

    #[test]
    fn rejects_out_of_range_values() {
        assert!(compute(&[item("-1", "10", "0", "0")]).is_err());
        assert!(compute(&[item("1", "10", "101", "0")]).is_err());
        assert!(compute(&[item("1", "10.001", "0", "0")]).is_err());
        assert!(compute(&[item("1000000", "100000000", "0", "0")]).is_err());
    }

    #[test]
    fn zero_lines_are_fine() {
        let t = compute(&[item("0", "0", "0", "0")]).unwrap();
        assert_eq!(t.grand_total, Decimal::ZERO);
    }
}
