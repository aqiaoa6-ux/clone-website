export function formatMoney(amount, currency) {
  const n = Number(amount);
  const a = Number.isFinite(n) ? n : amount;
  return `${a} ${String(currency ?? "").toUpperCase()}`.trim();
}

export function formatOrderStatus(status) {
  switch (status) {
    case "waiting_bind":
      return "等待对方绑定";
    case "waiting_payment":
      return "等待买方付款";
    case "paid_waiting_release":
      return "等待卖方放币";
    case "completed":
      return "订单已完成";
    case "cancelled":
      return "订单已取消";
    case "frozen":
      return "订单已冻结(管理员介入)";
    default:
      return String(status ?? "unknown");
  }
}

export function formatUserStats(stats) {
  const s = stats && typeof stats === "object" ? stats : {};
  const total = Number(s.total ?? 0);
  const success = Number(s.success ?? 0);
  const cancelled = Number(s.cancelled ?? 0);
  return `交易${total}笔, 成功${success}笔, 取消${cancelled}笔`;
}

