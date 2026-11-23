export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("Ninja Ship OA Tai Xe dang hoat dong!", { status: 200 });
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const eventName = body.event_name;
        if (eventName === "user_send_text" || eventName === "user_submit_info") {
          const driverId = body.sender?.id;
          const text = (body.message?.text || "").trim();
          if (driverId) ctx.waitUntil(handleDriverMessage(driverId, text, env));
        }
        if (eventName === "user_send_location") {
          const driverId = body.sender?.id;
          const lat = parseFloat(body.message?.attachments?.[0]?.payload?.coordinates?.latitude);
          const lng = parseFloat(body.message?.attachments?.[0]?.payload?.coordinates?.longitude);
          if (driverId && !isNaN(lat) && !isNaN(lng)) ctx.waitUntil(handleDriverLocation(driverId, lat, lng, env));
        }
        return new Response(JSON.stringify({ error: 0, message: "ok" }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: 1, message: err.message }), { status: 200 });
      }
    }
    return new Response("Method Not Allowed", { status: 405 });
  },
};

async function handleDriverMessage(driverId, text, env) {
  const lower = text.toLowerCase();
  let driver = await getDriverProfile(driverId, env);

  if (["menu", "hi", "hello", "bắt đầu", "start", "0"].includes(lower)) {
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, buildDriverMenuText(driver));
  }
  if (lower.startsWith("dk")) {
    const parts = text.split("|").map((s) => s.trim());
    if (parts.length < 3) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "🏍️ Nhắn: DK | Họ tên | Biển số xe\nVí dụ: DK | Trần Minh Tuấn | 74A1-111.11");
    driver.name = parts[1]; driver.plate = parts[2].toUpperCase(); driver.online = true;
    await saveDriverProfile(driverId, driver, env);
    await setDriverOnlineStatus(driverId, true, env);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `✅ ĐÃ ĐĂNG KÝ: ${driver.name} (${driver.plate}) - 🟢 ĐANG TRỰC TUYẾN`);
  }
  if (lower === "online" || lower === "bat ca" || lower === "bật ca") {
    driver.online = true; await saveDriverProfile(driverId, driver, env); await setDriverOnlineStatus(driverId, true, env);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "🟢 BẠN ĐÃ BẬT CA TRỰC TUYẾN!");
  }
  if (lower === "offline" || lower === "nghi ca" || lower === "nghỉ ca") {
    driver.online = false; await saveDriverProfile(driverId, driver, env); await setDriverOnlineStatus(driverId, false, env);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "🔴 BẠN ĐÃ TẮT CA. Nhắn ONLINE để nhận đơn lại.");
  }
  if (lower === "don" || lower === "đơn" || lower === "list") {
    const rawPending = await env.NINJA_KV.get("orders:pending");
    const ids = rawPending ? JSON.parse(rawPending) : [];
    const activeOrders = [];
    for (const id of ids) {
      const rawO = await env.NINJA_KV.get(`order:${id}`);
      if (rawO) { const o = JSON.parse(rawO); if (o.status === "pending") activeOrders.push(o); }
    }
    if (!activeOrders.length) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "📡 Chưa có đơn mới đang chờ.");
    const lines = activeOrders.slice(0, 5).map((o) => `• #${o.id}: ${o.note} (${o.km}km - ${formatVND(o.price)})\n  ${o.pointA} ➔ ${o.pointB}\n  👉 Nhắn: NHAN ${o.id}`);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "📦 ĐƠN ĐANG CHỜ NHẬN:\n\n" + lines.join("\n\n"));
  }
  if (lower.startsWith("nhan ")) {
    const orderId = text.split(" ")[1]?.toUpperCase();
    const rawOrder = await env.NINJA_KV.get(`order:${orderId}`);
    if (!rawOrder) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "❌ Không tìm thấy đơn #" + orderId);
    const order = JSON.parse(rawOrder);
    if (order.status !== "pending") return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `⚠️ Đơn #${orderId} đã có người nhận!`);
    order.status = "accepted"; order.driverId = driverId; order.driverName = driver.name; order.driverPlate = driver.plate;
    await env.NINJA_KV.put(`order:${orderId}`, JSON.stringify(order));
    await sendZaloMessage(order.customerId, env.ZALO_KHACH_TOKEN, `🏍️ TÀI XẾ ${driver.name} (${driver.plate}) ĐÃ NHẬN ĐƠN #${orderId} và đang tới ${order.pointA}!`);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `✅ ĐÃ NHẬN ĐƠN #${orderId}!\n• ${order.note}\n• ${order.pointA} ➔ ${order.pointB}\n• Cước: ${formatVND(order.price)}\n👉 Mua xong nhắn: DAMUA ${orderId}`);
  }
  if (lower.startsWith("damua ")) {
    const orderId = text.split(" ")[1]?.toUpperCase();
    const rawOrder = await env.NINJA_KV.get(`order:${orderId}`);
    if (!rawOrder) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "❌ Không tìm thấy đơn #" + orderId);
    const order = JSON.parse(rawOrder);
    if (order.driverId !== driverId) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "⚠️ Không phải đơn của bạn.");
    order.status = "bought";
    await env.NINJA_KV.put(`order:${orderId}`, JSON.stringify(order));
    await sendZaloMessage(order.customerId, env.ZALO_KHACH_TOKEN, `🛍️ TÀI XẾ ĐÃ LẤY XONG ĐƠN #${orderId} và đang giao tới ${order.pointB}!`);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `🛍️ ĐANG ĐI GIAO #${orderId}. Giao xong nhắn: HOANTAT ${orderId}`);
  }
  if (lower.startsWith("hoantat ")) {
    const orderId = text.split(" ")[1]?.toUpperCase();
    const rawOrder = await env.NINJA_KV.get(`order:${orderId}`);
    if (!rawOrder) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "❌ Không tìm thấy đơn #" + orderId);
    const order = JSON.parse(rawOrder);
    if (order.driverId !== driverId) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "⚠️ Không phải đơn của bạn.");
    order.status = "completed";
    await env.NINJA_KV.put(`order:${orderId}`, JSON.stringify(order));
    driver.earnings = (driver.earnings || 0) + order.price;
    if (order.paidOnline) driver.balance = (driver.balance || 0) + order.price;
    await saveDriverProfile(driverId, driver, env);
    await sendZaloMessage(order.customerId, env.ZALO_KHACH_TOKEN, `✅ ĐƠN #${orderId} ĐÃ GIAO THÀNH CÔNG! Cảm ơn bạn đã dùng Ninja Ship.`);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `🎉 HOÀN TẤT #${orderId}! Ví Tài Xế: ${formatVND(driver.balance)} | Thu nhập: ${formatVND(driver.earnings)}`);
  }
  if (lower.startsWith("nap")) {
    const amount = Math.max(10000, parseInt(text.replace(/\D/g, "")) || 100000);
    const memo = `NAP TX ${driverId.slice(-6).toUpperCase()}`;
    const qrUrl = `https://img.vietqr.io/image/${env.BANK_ID || "MB"}-${env.BANK_ACCOUNT || "0988886666"}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}`;
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `🏦 NẠP VÍ TÀI XẾ: ${formatVND(amount)}\n• ND: ${memo}\n• QR: ${qrUrl}\n✅ Nhắn "XACNHAN NAP ${amount}" để cộng tiền test.`);
  }
  if (lower.startsWith("xacnhan nap")) {
    const amount = Math.max(10000, parseInt(text.replace(/\D/g, "")) || 100000);
    driver.balance = (driver.balance || 0) + amount;
    await saveDriverProfile(driverId, driver, env);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `✅ ĐÃ NẠP +${formatVND(amount)}! Số dư Ví: ${formatVND(driver.balance)}`);
  }
  if (lower.startsWith("rut")) {
    const parts = text.split("|").map((s) => s.trim());
    if (parts.length < 3) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, "⬆️ Nhắn: RUT | Số tiền | Ngân hàng/Ví + STK + Tên");
    const amount = parseInt(parts[1].replace(/\D/g, "")) || 0;
    if (amount < 10000 || driver.balance < amount) return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `❌ Số dư (${formatVND(driver.balance)}) không đủ.`);
    driver.balance -= amount;
    await saveDriverProfile(driverId, driver, env);
    return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `✅ ĐÃ RÚT ${formatVND(amount)} về ${parts[2]}. Số dư còn: ${formatVND(driver.balance)}`);
  }
  return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, buildDriverMenuText(driver));
}

async function handleDriverLocation(driverId, lat, lng, env) {
  let driver = await getDriverProfile(driverId, env);
  driver.lat = lat; driver.lng = lng;
  await saveDriverProfile(driverId, driver, env);
  return sendZaloMessage(driverId, env.ZALO_TAIXE_TOKEN, `📍 Đã cập nhật GPS (${lat.toFixed(5)}, ${lng.toFixed(5)}).`);
}

async function sendZaloMessage(userId, accessToken, text) {
  if (!accessToken || !userId) return;
  return fetch("https://openapi.zalo.me/v3.0/oa/message/cs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "access_token": accessToken },
    body: JSON.stringify({ recipient: { user_id: userId }, message: { text } }),
  });
}

async function getDriverProfile(driverId, env) {
  const raw = await env.NINJA_KV.get(`driver:${driverId}`);
  if (raw) return JSON.parse(raw);
  const fresh = { id: driverId, name: "Tài xế #" + driverId.slice(-4), plate: "Chưa cập nhật", online: true, balance: 200000, earnings: 0 };
  await env.NINJA_KV.put(`driver:${driverId}`, JSON.stringify(fresh));
  await setDriverOnlineStatus(driverId, true, env);
  return fresh;
}
async function saveDriverProfile(driverId, profile, env) { await env.NINJA_KV.put(`driver:${driverId}`, JSON.stringify(profile)); }
async function setDriverOnlineStatus(driverId, isOnline, env) {
  const raw = await env.NINJA_KV.get("drivers:online");
  let list = raw ? JSON.parse(raw) : [];
  if (isOnline) { if (!list.includes(driverId)) list.push(driverId); } else { list = list.filter((id) => id !== driverId); }
  await env.NINJA_KV.put("drivers:online", JSON.stringify(list));
}
function buildDriverMenuText(driver) {
  return `🏍️ NINJA SHIP - OA TÀI XẾ (${driver.name} • ${driver.plate})\n• Trạng thái: ${driver.online ? "🟢 Trực tuyến" : "🔴 Nghỉ ca"}\n• Ví: ${formatVND(driver.balance)} | Thu nhập: ${formatVND(driver.earnings)}\n• DK | Tên | Biển số\n• ONLINE / OFFLINE / DON / NAP / RUT`;
}
function formatVND(num) { return Number(num || 0).toLocaleString("vi-VN") + "đ"; }