export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
/** Shown on the legal pages when set (NEXT_PUBLIC_SUPPORT_EMAIL). Empty means no address is displayed. */
export const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "").trim();
export const SITE_NAME = "bizinvoX.com";
export const SHORT_NAME = "bizinvoX";
export const SITE_DESCRIPTION =
  "Free invoice generator: create a professional invoice online in under a minute. Custom invoice templates, branding and unlimited downloads with Pro.";
