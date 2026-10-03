import { Order, ORDER_STATUSES } from "../models/Order.js";

const calculateTotal = (items) =>
  Number(items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0).toFixed(2));

const validateCreateOrder = (body) => {
  if (!body?.orderId?.trim()) return "orderId is required";
  if (!body?.customer?.name?.trim()) return "customer.name is required";
  if (!body?.customer?.phone?.trim()) return "customer.phone is required";
  if (!Array.isArray(body.items) || body.items.length === 0) return "At least one item is required";
  if (!body?.shippingAddress?.addressLine1?.trim()) return "shippingAddress.addressLine1 is required";
  if (!body?.shippingAddress?.city?.trim()) return "shippingAddress.city is required";
  if (!body?.shippingAddress?.state?.trim()) return "shippingAddress.state is required";
  if (!body?.shippingAddress?.pincode?.trim()) return "shippingAddress.pincode is required";

  for (const item of body.items) {
    if (!item?.productName?.trim()) return "item.productName is required";
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 1) return "item.quantity must be at least 1";
    if (!Number.isFinite(Number(item.price)) || Number(item.price) < 0) return "item.price must be a non-negative number";
  }

  return null;
};

export async function listOrders(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const filter = {};

  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "").trim();

  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { orderId: { $regex: search, $options: "i" } },
      { "customer.name": { $regex: search, $options: "i" } },
      { "customer.phone": { $regex: search, $options: "i" } }
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter)
  ]);

  res.json({
    success: true,
    data: {
      orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    }
  });
}

export async function getOrder(req, res) {
  const order = await Order.findById(req.params.id).lean();
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  res.json({ success: true, data: order });
}

export async function createOrder(req, res) {
  const validationError = validateCreateOrder(req.body);
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  try {
    const order = await Order.create({
      orderId: req.body.orderId,
      customer: req.body.customer,
      items: req.body.items,
      totalAmount: calculateTotal(req.body.items),
      status: req.body.status || "pending",
      shippingAddress: req.body.shippingAddress
    });

    res.status(201).json({ success: true, data: order });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "An order with this orderId already exists" });
    }
    throw error;
  }
}

export async function updateOrder(req, res) {
  const allowed = ORDER_STATUSES;
  const updates = {};

  // Orders that came from Rafttaar are driven by Rafttaar's own lifecycle
  // (acknowledge/confirm/dispatch...). Letting someone flip the status here
  // would make the ERP disagree with Rafttaar, so route them to the actions.
  const existing = await Order.findById(req.params.id).select("source status").lean();
  if (existing?.source === "rafttaar" && req.body.status !== undefined && req.body.status !== existing.status) {
    return res.status(409).json({
      success: false,
      code: "USE_RAFTTAAR_ACTIONS",
      message:
        "This order is managed through Rafttaar. Use its Rafttaar actions (acknowledge, confirm, dispatch, cancel) instead of editing the status."
    });
  }

  if (req.body.status !== undefined) {
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed values: ${allowed.join(", ")}` });
    }
    updates.status = req.body.status;
  }

  if (req.body.totalAmount !== undefined) {
    const amount = Number(req.body.totalAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ success: false, message: "totalAmount must be a non-negative number" });
    }
    updates.totalAmount = amount;
  }

  const order = await Order.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true }).lean();
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  res.json({ success: true, data: order });
}

export async function deleteOrder(req, res) {
  const order = await Order.findByIdAndDelete(req.params.id).lean();
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  res.json({ success: true, message: "Order deleted successfully" });
}
