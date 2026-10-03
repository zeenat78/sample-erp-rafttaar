import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { Counter, Invoice } from "../../models/Invoice.js";
import { getClient, getSettings, loadConfig } from "./config.js";
import { ActionError } from "./actions.js";

/**
 * GST invoice for a Rafttaar order (only valid when the seller's integration is
 * invoiceSource=erp — otherwise Rafttaar answers INVOICE_LOCKED).
 *
 * Rafttaar rejects an invoice whose lines/tax do not reconcile EXACTLY with the
 * order's own totals, so the numbers are not "our choice": taxable value per
 * line = quantity x Rafttaar's unitPricePaise, and the order's gstPaise is
 * allocated across lines (largest remainder -> sums exactly, no drift), then
 * split CGST/SGST when seller and delivery state match, otherwise IGST.
 */

export const financialYearOf = (date) => {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // FY runs Apr-Mar
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};

export async function nextInvoiceNumber(date = new Date()) {
  const fy = financialYearOf(date);
  const counter = await Counter.findOneAndUpdate({ _id: `invoice:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return { fy, invoiceNumber: `ERP/${fy}/${String(counter.seq).padStart(4, "0")}` };
}

/** Largest-remainder split of `total` across `weights` so the parts sum EXACTLY to total. */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k].i] += 1;
  return out;
}

const sameState = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

async function totalsFor(order, client) {
  const t = order.rafttaar?.totals || {};
  if (t.subtotalPaise != null && t.gstPaise != null) return t;
  // Event-created orders only carry totalPaise; the order LIST row has the breakdown.
  for await (const row of client.iterateOrders({ limit: 100 })) {
    if (row.id === order.rafttaar.orderId) return { ...t, ...row.totals };
  }
  return t;
}

/**
 * Build and persist a DRAFT invoice (number allocated, PDF token minted).
 * `overrides`: { hsn, gstRatePercent, invoiceDate, sellerGstin, lines:[{lineId,hsn}] }
 */
export async function createInvoiceDraft(order, overrides = {}, { client } = {}) {
  const cfg = loadConfig();
  if (!/^https:\/\//.test(cfg.publicBaseUrl)) {
    throw new ActionError(
      400,
      "PUBLIC_URL_REQUIRED",
      "PUBLIC_BASE_URL (https) is not set. Rafttaar stores only a link to the invoice PDF, so it must point at a public https address of this ERP (the ngrok URL locally, the Render URL when deployed)."
    );
  }
  if (!order.items?.length || order.items.some((i) => !i.lineId)) {
    throw new ActionError(409, "ORDER_LINES_MISSING", "Order lines have no Rafttaar lineId — refresh the order from Rafttaar first");
  }
  const dup = await Invoice.findOne({ order: order._id, status: { $in: ["draft", "active"] } }).lean();
  if (dup) throw new ActionError(409, "INVOICE_ALREADY_EXISTS", `Invoice ${dup.invoiceNumber} already exists for this order — void it first to issue a new one`);

  client = client || getClient();
  const settings = await getSettings();
  const totals = await totalsFor(order, client);
  const hsnByLine = Object.fromEntries((overrides.lines || []).map((l) => [l.lineId, l.hsn]));
  const defaultHsn = overrides.hsn || settings.invoice?.defaultHsn || "9999";

  const taxable = order.items.map((i) => Math.round(i.unitPricePaise * i.quantity));
  const taxableSum = taxable.reduce((a, b) => a + b, 0);

  let taxTotal;
  if (totals.gstPaise != null) {
    if (totals.subtotalPaise != null && totals.subtotalPaise !== taxableSum) {
      throw new ActionError(
        409,
        "TOTALS_NOT_RECONCILABLE",
        `Order lines sum to ${taxableSum} paise but Rafttaar's subtotal is ${totals.subtotalPaise}; refusing to issue an invoice Rafttaar would reject`
      );
    }
    taxTotal = totals.gstPaise;
  } else {
    const rate = Number(overrides.gstRatePercent ?? settings.invoice?.defaultGstRatePercent ?? 0);
    taxTotal = Math.round((taxableSum * rate) / 100);
  }
  const taxes = allocate(taxTotal, taxable);

  const placeOfSupply = order.shippingAddress?.state || "";
  const sellerState = settings.invoice?.sellerState || "";
  const intra = sellerState ? sameState(sellerState, placeOfSupply) : false;

  const lines = order.items.map((item, i) => {
    const tax = taxes[i];
    const cgst = intra ? Math.floor(tax / 2) : 0;
    return {
      lineId: item.lineId,
      description: item.productName,
      hsn: hsnByLine[item.lineId] || defaultHsn,
      quantity: item.quantity,
      taxableValuePaise: taxable[i],
      cgstPaise: cgst,
      sgstPaise: intra ? tax - cgst : 0,
      igstPaise: intra ? 0 : tax,
      cessPaise: 0
    };
  });

  const invoiceDate = overrides.invoiceDate ? new Date(overrides.invoiceDate) : new Date();
  const { fy, invoiceNumber } = await nextInvoiceNumber(invoiceDate);
  return Invoice.create({
    order: order._id,
    rafttaarOrderId: order.rafttaar.orderId,
    invoiceNumber,
    financialYear: fy,
    invoiceDate,
    placeOfSupply,
    sellerGstin: overrides.sellerGstin || settings.invoice?.sellerGstin || "",
    buyerName: order.customer?.name,
    lines,
    taxableValuePaise: taxableSum,
    taxPaise: taxTotal,
    grandTotalPaise: taxableSum + taxTotal,
    status: "draft",
    pdfToken: crypto.randomBytes(24).toString("hex")
  });
}

export const pdfUrlFor = (invoice) => `${loadConfig().publicBaseUrl}/invoices/${invoice.pdfToken}.pdf`;

/** Local invoice -> body of POST /orders/{id}/invoice (CreateInvoiceRequest). */
export function toApiInvoice(invoice) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: new Date(invoice.invoiceDate).toISOString(),
    placeOfSupply: invoice.placeOfSupply || undefined,
    sellerGstin: invoice.sellerGstin || undefined,
    pdf: pdfUrlFor(invoice),
    lines: invoice.lines.map((l) => ({
      lineId: l.lineId,
      hsn: l.hsn,
      quantity: l.quantity,
      taxableValuePaise: l.taxableValuePaise,
      cgstPaise: l.cgstPaise || 0,
      sgstPaise: l.sgstPaise || 0,
      igstPaise: l.igstPaise || 0,
      cessPaise: l.cessPaise || 0
    }))
  };
}

// ------------------------------------------------------------------ PDF
const rs = (paise) => `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Streams a simple tax-invoice PDF into `stream` (an http response). */
export function renderInvoicePdf(invoice, order, stream) {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(stream);

  doc.fontSize(20).text("TAX INVOICE", { align: "right" });
  if (invoice.status === "voided") doc.fontSize(12).fillColor("#b42318").text("VOIDED", { align: "right" }).fillColor("#000");
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Invoice no: ${invoice.invoiceNumber}`);
  doc.text(`Date: ${new Date(invoice.invoiceDate).toLocaleDateString("en-IN")}`);
  doc.text(`Financial year: ${invoice.financialYear}`);
  if (invoice.sellerGstin) doc.text(`Seller GSTIN: ${invoice.sellerGstin}`);
  doc.text(`Place of supply: ${invoice.placeOfSupply || "-"}`);
  doc.text(`Rafttaar order: ${order?.rafttaar?.displayCode || invoice.rafttaarOrderId}`);
  doc.moveDown();

  doc.fontSize(11).text("Bill to", { underline: true });
  doc.fontSize(10).text(invoice.buyerName || "-");
  const a = order?.shippingAddress;
  if (a) doc.text([a.addressLine1, a.addressLine2, `${a.city}, ${a.state} ${a.pincode}`].filter(Boolean).join("\n"));
  doc.moveDown();

  const cols = [48, 230, 290, 340, 410, 470];
  const head = ["Item", "HSN", "Qty", "Taxable", "GST", "Total"];
  doc.fontSize(9).font("Helvetica-Bold");
  head.forEach((h, i) => doc.text(h, cols[i], doc.y, { width: 70, continued: i < head.length - 1 }));
  doc.font("Helvetica").moveDown(0.3);
  for (const l of invoice.lines) {
    const gst = (l.cgstPaise || 0) + (l.sgstPaise || 0) + (l.igstPaise || 0) + (l.cessPaise || 0);
    const y = doc.y;
    doc.text(l.description || l.lineId, cols[0], y, { width: 175 });
    doc.text(l.hsn || "-", cols[1], y, { width: 55 });
    doc.text(String(l.quantity), cols[2], y, { width: 45 });
    doc.text(rs(l.taxableValuePaise), cols[3], y, { width: 65 });
    doc.text(rs(gst), cols[4], y, { width: 55 });
    doc.text(rs(l.taxableValuePaise + gst), cols[5], y, { width: 75 });
    doc.moveDown(0.6);
  }
  doc.moveDown();
  doc.fontSize(10);
  doc.text(`Taxable value: ${rs(invoice.taxableValuePaise)}`, { align: "right" });
  doc.text(`GST: ${rs(invoice.taxPaise)}`, { align: "right" });
  doc.font("Helvetica-Bold").text(`Grand total: ${rs(invoice.grandTotalPaise)}`, { align: "right" });
  doc.font("Helvetica").moveDown(2);
  doc.fontSize(8).fillColor("#667085").text("Computer-generated invoice issued by the ERP on behalf of the seller.", { align: "center" });
  doc.end();
}
