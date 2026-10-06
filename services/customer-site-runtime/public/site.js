(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const say = (form, message) => {
    const node = $(".form-message", form);
    if (node) node.textContent = message;
  };
  const cartKey = "customer-site-cart";
  const getCart = () => {
    try {
      return JSON.parse(localStorage.getItem(cartKey) || "[]");
    } catch {
      return [];
    }
  };
  const setCart = items => {
    localStorage.setItem(cartKey, JSON.stringify(items));
    sessionStorage.removeItem("ds-order-idempotency");
    updateCart();
  };
  const updateCart = () => {
    const items = getCart();
    $$("[data-cart-count]").forEach(
      n =>
        (n.textContent = String(items.reduce((sum, i) => sum + i.quantity, 0)))
    );
    const host = $("[data-cart-items]");
    if (host)
      host.innerHTML = items.length
        ? items
            .map(
              (i, n) =>
                `<div class="service-row"><div><h2>${escapeHtml(i.name)}</h2><p>${formatMoney(i.priceMinor)} × ${i.quantity}</p></div><button type="button" data-remove-cart="${n}" aria-label="移除 ${escapeHtml(i.name)}">移除</button></div>`
            )
            .join("")
        : '<p class="empty-state">購物袋目前是空的，挑選幾件喜歡的商品吧。</p>';
    const total = $("[data-cart-total]");
    if (total)
      total.textContent = items.length
        ? `合計 · ${formatMoney(items.reduce((sum, i) => sum + i.priceMinor * i.quantity, 0))}`
        : "";
  };
  const escapeHtml = s =>
    String(s ?? "").replace(
      /[&<>"']/g,
      c =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]
    );
  const formatMoney = minor =>
    `TWD ${new Intl.NumberFormat("zh-TW").format((Number(minor) || 0) / 100)}`;
  const paymentLabel = status => ({ pending: "待確認付款", paid: "已付款", refunded: "已退款" })[status] || status || "未提供付款狀態";
  const fulfillmentLabel = status => ({ unfulfilled: "待處理", processing: "處理中", shipped: "已出貨", delivered: "已送達", cancelled: "已取消" })[status] || status || "未提供出貨狀態";
  const bookingLabel = status => ({ confirmed: "已確認", cancelled: "已取消", pending_hold: "等待商家確認", rejected: "未接受", expired: "已逾期" })[status] || status || "未提供狀態";
  const localDate = (value, timeZone = "Asia/Taipei") => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || "");
    const options = { timeZone, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try { return new Intl.DateTimeFormat("zh-TW", options).format(date); }
    catch { return new Intl.DateTimeFormat("zh-TW", { ...options, timeZone: "Asia/Taipei" }).format(date); }
  };
  const saveOrderToken = order => {
    if (!order?.id || !order.accessToken) return;
    sessionStorage.setItem(`ds-order-access-${order.id}`, JSON.stringify({ token: order.accessToken, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }));
  };
  const showOrder = async (order, host) => {
    saveOrderToken(order);
    let detail = order;
    try {
      const saved = order.id && sessionStorage.getItem(`ds-order-access-${order.id}`);
      const credential = saved ? JSON.parse(saved) : null;
      const token = order.accessToken || (credential?.expiresAt > Date.now() ? credential.token : "");
      if (order.id && token) detail = await api(`/api/orders/${encodeURIComponent(order.id)}`, { headers: { "x-order-token": token } });
    } catch { /* keep the safe order receipt already returned by the authorized request */ }
    if (!host) return;
    const items = (detail.items || []).map(item => `<li>${escapeHtml(item.name)}${item.variantLabel ? ` · ${escapeHtml(item.variantLabel)}` : ""} × ${escapeHtml(item.quantity)}</li>`).join("");
    const tracking = (detail.tracking || []).map(event => `<p>${escapeHtml(event.label)} · ${escapeHtml(event.createdAt)}${event.metadata?.carrier ? ` · ${escapeHtml(event.metadata.carrier)} ${escapeHtml(event.metadata.trackingNumber || "")}` : ""}</p>`).join("");
    let card = $("[data-order-details]");
    if (!card) { card = document.createElement("section"); card.className = "order-receipt"; card.dataset.orderDetails = ""; host.insertAdjacentElement("afterend", card); }
    card.innerHTML = `<h2>訂單 ${escapeHtml(detail.number || "")}</h2><p>${escapeHtml(paymentLabel(detail.paymentStatus))} · ${escapeHtml(fulfillmentLabel(detail.fulfillmentStatus))}</p><p>合計 ${formatMoney(detail.totalMinor || 0)}</p><ul>${items}</ul>${tracking || "<p>目前尚無物流更新。</p>"}`;
  };
  const addVariantRow = (container, value = {}) => {
    const row = document.createElement("div");
    row.className = "variant-row";
    row.innerHTML =
      '<input type="hidden" data-variant-id><input data-variant-label placeholder="規格名稱" aria-label="規格名稱" required><input type="number" data-variant-price placeholder="價格（最小貨幣單位）" aria-label="價格（最小貨幣單位）" min="1" required><input type="number" data-variant-stock placeholder="庫存" aria-label="庫存" min="0" required><button type="button" data-remove-variant aria-label="移除規格">移除規格</button>';
    row.querySelector("[data-variant-id]").value = value.id || "";
    row.querySelector("[data-variant-label]").value = value.label || "";
    row.querySelector("[data-variant-price]").value = value.priceMinor ?? "";
    row.querySelector("[data-variant-stock]").value = value.stock ?? "";
    const remove = row.querySelector("[data-remove-variant]");
    remove.disabled = Boolean(value.id);
    container.append(row);
  };
  const localInputValue = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  };
  let sessionPromise;
  const session = () =>
    (sessionPromise ||= fetch("/api/session", { credentials: "same-origin" })
      .then(async r => (r.ok ? r.json() : { actor: null, csrfToken: "" }))
      .catch(() => ({ actor: null, csrfToken: "" })));
  const api = async (url, { method = "GET", body, headers = {} } = {}) => {
    const options = {
      method,
      credentials: "same-origin",
      headers: { ...headers },
    };
    if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
      const s = await session();
      if (s.csrfToken) options.headers["x-csrf-token"] = s.csrfToken;
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.message || data.error || `請求失敗（${response.status}）。請稍後再試。`
      );
    return data;
  };
  const values = form => Object.fromEntries(new FormData(form).entries());
  const submit = (form, fn) =>
    form?.addEventListener("submit", async event => {
      event.preventDefault();
      const button = $('button[type="submit"],button:not([type])', form);
      if (button) button.disabled = true;
      say(form, "");
      try {
        await fn(values(form), form);
      } catch (error) {
        say(form, error.message);
      } finally {
        if (button) button.disabled = false;
      }
    });

  const menuButton = $(".menu-toggle");
  menuButton?.addEventListener("click", () => {
    const nav = $(".site-header nav");
    const open = nav?.classList.toggle("is-open");
    menuButton.setAttribute("aria-expanded", String(Boolean(open)));
    menuButton.setAttribute("aria-label", open ? "關閉選單" : "開啟選單");
  });
  document.addEventListener("click", async event => {
    const editProduct = event.target.closest("[data-edit-product]");
    if (editProduct) {
      const form = $("[data-admin-product]");
      if (form) {
        for (const key of [
          "id",
          "version",
          "name",
          "slug",
          "category",
          "description",
          "priceMinor",
          "stock",
          "image",
        ]) {
          const field = form.elements.namedItem(key);
          if (field)
            field.value =
              {
                id: editProduct.dataset.editProduct,
                version: editProduct.dataset.version,
                priceMinor: editProduct.dataset.price,
                image: editProduct.dataset.image,
              }[key] ?? editProduct.dataset[key];
        }
        const active = form.elements.namedItem("active");
        if (active) active.checked = editProduct.dataset.active === "true";
        const rows = $(`[data-variant-rows]`, form);
        if (rows) {
          rows.replaceChildren();
          try {
            JSON.parse(editProduct.dataset.variants || "[]").forEach(variant =>
              addVariantRow(rows, variant)
            );
          } catch {
            /* malformed view data stays empty */
          }
        }
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    const editBlog = event.target.closest("[data-edit-blog]");
    if (editBlog) {
      const form = $("[data-admin-blog]");
      if (form) {
        for (const key of [
          "id",
          "version",
          "title",
          "slug",
          "summary",
          "body",
          "cover",
        ])
          form.elements.namedItem(key).value =
            key === "id" ? editBlog.dataset.editBlog : editBlog.dataset[key];
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    const editService = event.target.closest("[data-edit-service]");
    if (editService) {
      const form = $(`[data-admin-service]`);
      if (form) {
        form.elements.namedItem("id").value = editService.dataset.editService;
        form.elements.namedItem("version").value = editService.dataset.version;
        form.elements.namedItem("name").value = editService.dataset.name;
        form.elements.namedItem("durationMinutes").value = editService.dataset.duration;
        form.elements.namedItem("creditCost").value = editService.dataset.credit;
        form.elements.namedItem("active").checked = editService.dataset.active === "true";
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    const editSlot = event.target.closest("[data-edit-slot]");
    if (editSlot) {
      const form = $(`[data-admin-slot]`);
      if (form) {
        form.elements.namedItem("id").value = editSlot.dataset.editSlot;
        form.elements.namedItem("version").value = editSlot.dataset.version;
        form.elements.namedItem("serviceId").value = editSlot.dataset.service;
        form.elements.namedItem("startsAt").value = localInputValue(editSlot.dataset.startsAt);
        form.elements.namedItem("resourceId").value = editSlot.dataset.resource;
        form.elements.namedItem("active").checked = editSlot.dataset.active === "true";
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    if (event.target.closest("[data-add-variant]")) {
      const form = event.target.closest("[data-admin-product]");
      const rows = form && $(`[data-variant-rows]`, form);
      if (rows) addVariantRow(rows);
    }
    if (event.target.closest("[data-remove-variant]"))
      event.target.closest(".variant-row")?.remove();
    const add = event.target.closest("[data-add-to-cart]");
    if (add) {
      const items = getCart();
      const id = add.dataset.addToCart;
      const variant = $("[data-variant]");
      const variantOption = variant?.selectedOptions?.[0];
      const variantId = variantOption?.value || "";
      const found = items.find(i => i.id === id && i.variantId === variantId);
      const quantity = Math.max(1, Number($("[data-quantity]")?.value || 1));
      const priceMinor = Number(
        variantOption?.dataset.price || add.dataset.price
      );
      if (found) found.quantity += quantity;
      else
        items.push({
          id,
          variantId,
          name: add.dataset.name,
          priceMinor,
          quantity,
        });
      setCart(items);
      const msg = $(".form-message");
      if (msg) msg.textContent = "已加入購物袋。";
    }
    const remove = event.target.closest("[data-remove-cart]");
    if (remove) {
      const items = getCart();
      items.splice(Number(remove.dataset.removeCart), 1);
      setCart(items);
    }
    const publish = event.target.closest("[data-publish-post]");
    if (publish) {
      const action =
        publish.textContent.trim() === "發布" ? "publish" : "unpublish";
      try {
        await api(
          `/api/admin/blog/${encodeURIComponent(publish.dataset.publishPost)}/${action}`,
          { method: "POST", body: { version: Number(publish.dataset.version) } }
        );
        location.reload();
      } catch (error) {
        const m = $("[data-admin-message]");
        if (m) m.textContent = error.message;
      }
    }
  });
  const runOrderAction = async orderAction => {
    if (!orderAction?.value) return;
    const action = orderAction.value;
    const body = { action };
    if (action === "ship") {
      body.carrier = prompt("請輸入物流業者");
      body.trackingNumber = prompt("請輸入物流追蹤編號");
      if (!body.carrier || !body.trackingNumber) { orderAction.value = ""; return; }
    }
    if (action === "refund") {
      body.reference = prompt("請輸入退款參考編號");
      if (!body.reference) { orderAction.value = ""; return; }
    }
    orderAction.disabled = true;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(orderAction.dataset.orderAction)}`, { method: "PATCH", body });
      location.reload();
    } catch (error) {
      orderAction.disabled = false;
      orderAction.value = "";
      const message = $("[data-admin-message]");
      if (message) message.textContent = error.message;
    }
  };
  $$ ("[data-order-action]").forEach(select => select.addEventListener("change", () => runOrderAction(select)));
  $$("[data-post-revisions]").forEach(button =>
    button.addEventListener("click", async () => {
      try {
        const id = button.dataset.postRevisions;
        const result = await api(
          `/api/admin/blog/${encodeURIComponent(id)}/revisions`
        );
        const revisions = result.revisions || [];
        if (!revisions.length) {
          const m = $("[data-admin-message]");
          if (m) m.textContent = "目前沒有修訂記錄。";
          return;
        }
        const choice = prompt(
          `輸入要還原的修訂編號（取消以離開）：\n${revisions.map((r, i) => `${i + 1}. ${r.status} · ${r.version} · ${r.createdAt}`).join("\n")}`
        );
        if (choice === null) return;
        const revision = revisions[Number(choice) - 1];
        if (!revision || !confirm(`要將「${revision.title}」還原為草稿嗎？`))
          return;
        await api(`/api/admin/blog/${encodeURIComponent(id)}/restore`, {
          method: "POST",
          body: {
            revisionId: revision.id,
            version: Number(button.dataset.version),
          },
        });
        location.reload();
      } catch (error) {
        const m = $("[data-admin-message]");
        if (m) m.textContent = error.message;
      }
    })
  );
  $("[data-variant]")?.addEventListener("change", event => {
    const option = event.currentTarget.selectedOptions[0];
    const quantity = $(`[data-quantity]`);
    const addButton = $(`[data-add-to-cart]`);
    const price = $(`[data-product-price]`);
    if (quantity) {
      quantity.max = String(Number(option.dataset.stock) || 1);
      quantity.value = "1";
    }
    if (price)
      price.textContent = formatMoney(Number(option.dataset.price) || 0);
    if (addButton) addButton.disabled = Number(option.dataset.stock) <= 0;
  });
  const initialVariant = $("[data-variant]");
  if (initialVariant) initialVariant.dispatchEvent(new Event("change"));
  const bookingForm = $("[data-booking-form]");
  const servicePicker = bookingForm?.elements.namedItem("serviceId");
  const slotPicker = bookingForm?.elements.namedItem("slotId");
  servicePicker?.addEventListener("change", async () => {
    if (!slotPicker) return;
    slotPicker.disabled = true;
    try {
      const result = await api(
        `/api/slots?serviceId=${encodeURIComponent(servicePicker.value)}`
      );
      const available = (result.slots || []).filter(slot => slot.available);
      slotPicker.innerHTML = available
        .map(
          slot =>
            `<option value="${escapeHtml(slot.id)}">${escapeHtml(localDate(slot.startsAt, bookingForm.dataset.timeZone || "Asia/Taipei"))}</option>`
        )
        .join("");
      if (!available.length)
        slotPicker.innerHTML = '<option value="">目前沒有可預約時段</option>';
    } catch (error) {
      slotPicker.innerHTML =
        '<option value="">時段載入失敗，請稍後重試</option>';
    } finally {
      slotPicker.disabled = false;
    }
  });
  bookingForm?.addEventListener("input", () => sessionStorage.removeItem("ds-booking-idempotency"));
  bookingForm?.addEventListener("change", () => sessionStorage.removeItem("ds-booking-idempotency"));
  const checkoutForm = $("[data-checkout-form]");
  checkoutForm?.addEventListener("input", () => sessionStorage.removeItem("ds-order-idempotency"));
  checkoutForm?.addEventListener("change", () => sessionStorage.removeItem("ds-order-idempotency"));
  const actionTokenHash = ["/reset-password", "/verify-email"].includes(location.pathname);
  let actionToken = "";
  if (actionTokenHash && location.hash) {
    actionToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  submit($("[data-login-form]"), async (data, form) => {
    const result = await api("/api/auth/login", { method: "POST", body: data });
    sessionPromise = Promise.resolve({
      actor: result.actor,
      csrfToken: result.csrfToken,
    });
    location.assign("/account");
  });
  submit($("[data-register-form]"), async data => {
    data.consent = data.consent === "true";
    if (!data.consent) throw new Error("請先同意隱私說明。");
    const result = await api("/api/auth/register", {
      method: "POST",
      body: data,
    });
    sessionPromise = Promise.resolve({
      actor: result.actor,
      csrfToken: result.csrfToken,
    });
    location.assign("/account");
  });
  submit($("[data-admin-login]"), async data => {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: data,
    });
    sessionPromise = Promise.resolve({
      actor: result.actor,
      csrfToken: result.csrfToken,
    });
    location.assign("/admin");
  });
  submit($('[data-password-reset-request]'), async (data, form) => {
    await api('/api/auth/password-reset/request', { method: 'POST', body: data });
    say(form, '若此電子郵件已有帳號，重設連結將寄送至該信箱。');
  });
  submit($('[data-password-reset-confirm]'), async (data, form) => {
    if (!actionToken) throw new Error('重設連結已失效，請重新申請。');
    await api('/api/auth/password-reset/confirm', { method: 'POST', body: { token: actionToken, password: data.password } });
    actionToken = '';
    form.reset();
    say(form, '密碼已更新，請使用新密碼登入。');
  });
  const verifyStatus = $('[data-email-verification-status]');
  if (verifyStatus) {
    if (!actionToken) verifyStatus.textContent = '驗證連結已失效，請重新登入後申請新的驗證信。';
    else api('/api/auth/email/confirm', { method: 'POST', body: { token: actionToken } })
      .then(() => { actionToken = ''; verifyStatus.textContent = '電子郵件已驗證，謝謝你。'; })
      .catch(error => { verifyStatus.textContent = error.message; });
  }
  $('[data-email-verification-request]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await api('/api/auth/email/request', { method: 'POST', body: {} }); $('[data-verification-message]').textContent = '若帳號仍需驗證，驗證連結將寄送至會員信箱。'; }
    catch (error) { $('[data-verification-message]').textContent = error.message; }
    finally { button.disabled = false; }
  });
  submit($("[data-booking-form]"), async (data, form) => {
    const idempotencyName = "ds-booking-idempotency";
    data.idempotencyKey = sessionStorage.getItem(idempotencyName) || crypto.randomUUID();
    sessionStorage.setItem(idempotencyName, data.idempotencyKey);
    const guest = Boolean(data.name);
    if (guest) {
      data.consent = data.consent === "true";
      if (!data.consent) throw new Error("請先同意聯絡資料使用說明。");
    }
    const result = await api(
      guest ? "/api/booking-requests" : "/api/bookings",
      { method: "POST", body: data }
    );
    sessionStorage.removeItem(idempotencyName);
    say(
      form,
      result.message ||
        (guest
          ? "已收到預約申請，商家確認前尚未完成預約或付款。"
          : "預約已送出。")
    );
  });
  submit($("[data-checkout-form]"), async (data, form) => {
    const items = getCart();
    if (!items.length) throw new Error("購物袋目前是空的。");
    if (!data.consent)
      throw new Error("請先勾選同意購物條款與隱私說明。");
    const keyName = "ds-order-idempotency";
    let idempotencyKey = sessionStorage.getItem(keyName);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      sessionStorage.setItem(keyName, idempotencyKey);
    }
    const result = await api("/api/orders", {
      method: "POST",
      body: {
        customer: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          address: data.address,
        },
        consent: true,
        idempotencyKey,
        items: items.map(({ id, variantId, quantity }) => ({
          productId: id,
          ...(variantId ? { variantId } : {}),
          quantity,
        })),
      },
    });
    sessionStorage.removeItem(keyName);
    localStorage.removeItem(cartKey);
    setCart([]);
    say(
      form,
      `已收到訂單 ${result.number || ""}。目前尚未收款。`
    );
    await showOrder(result, form);
  });
  submit($("[data-order-lookup]"), async (data, form) => {
    const result = await api("/api/orders/lookup", {
      method: "POST",
      body: data,
    });
    say(
      form,
      `已找到訂單 ${result.number || ""}。`
    );
    await showOrder(result, form);
  });
  submit($("[data-contact-form]"), async (data, form) => {
    data.consent = data.consent === "true";
    if (!data.consent) throw new Error("請先同意聯絡資料使用說明。");
    await api("/api/contact", { method: "POST", body: data });
    form.reset();
    say(form, "訊息已送出，謝謝您。");
  });
  submit($("[data-admin-product]"), async data => {
    if (!data.id) delete data.id;
    if (!data.version) delete data.version;
    data.priceMinor = Number(data.priceMinor);
    data.stock = Number(data.stock || 0);
    data.active = data.active === "on";
    data.slug =
      data.slug ||
      data.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    data.category = data.category || "General";
    data.description = data.description || "";
    data.images = data.image ? [data.image] : [];
    data.variants = $$(`[data-variant-rows] .variant-row`).map(row => ({
      ...(row.querySelector("[data-variant-id]").value
        ? { id: row.querySelector("[data-variant-id]").value }
        : {}),
      label: row.querySelector("[data-variant-label]").value,
      priceMinor: Number(row.querySelector("[data-variant-price]").value),
      stock: Number(row.querySelector("[data-variant-stock]").value),
    }));
    delete data.sku;
    delete data.image;
    await api("/api/admin/products", { method: "POST", body: data });
    location.reload();
  });
  submit($("[data-admin-slot]"), async data => {
    if (!data.id) delete data.id;
    if (!data.version) delete data.version;
    data.active = data.active === "on";
    data.startsAt = new Date(data.startsAt).toISOString();
    await api("/api/admin/slots", { method: "POST", body: data });
    location.reload();
  });
  submit($("[data-admin-service]"), async data => {
    if (!data.id) delete data.id;
    if (!data.version) delete data.version;
    data.durationMinutes = Number(data.durationMinutes);
    data.creditCost = Number(data.creditCost);
    data.active = data.active === "on";
    await api("/api/admin/services", { method: "POST", body: data });
    location.reload();
  });
  submit($("[data-admin-blog]"), async data => {
    if (!data.id) delete data.id;
    if (!data.version) delete data.version;
    data.draft = true;
    await api("/api/admin/blog", { method: "POST", body: data });
    location.reload();
  });
  submit($("[data-admin-settings]"), async data => {
    const body = {
      preset: data.preset,
      tagline: data.tagline,
      description: data.description,
      about: data.about,
      hero: {
        title: data.heroTitle,
        description: data.heroDescription,
        image: data.heroImage,
      },
      contact: {
        email: data.contactEmail,
        phone: data.contactPhone,
        address: data.contactAddress,
      },
      policies: {
        shipping: data.policy_shipping,
        returns: data.policy_returns,
        privacy: data.policy_privacy,
      },
    };
    await api("/api/admin/settings", { method: "PATCH", body });
    location.reload();
  });
  $$("[data-media-upload]").forEach(input =>
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const message = $("[data-admin-message]");
      if (message) message.textContent = "圖片上傳中…";
      try {
        const s = await session();
        const response = await fetch("/api/admin/media", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": file.type,
            ...(s.csrfToken ? { "x-csrf-token": s.csrfToken } : {}),
          },
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            result.message || result.error || "圖片上傳失敗。"
          );
        const field = input
          .closest(".admin-panel")
          ?.querySelector(
            'input[name="image"],input[name="cover"],input[name="heroImage"]'
          );
        if (field) field.value = result.url;
        if (message) message.textContent = `Image ready: ${result.url}`;
      } catch (error) {
        if (message) message.textContent = error.message;
      }
    })
  );
  const messageHost = $("[data-contact-messages]");
  if (messageHost)
    api("/api/admin/contact-messages")
      .then(data => {
        const messages = Array.isArray(data) ? data : data.messages || [];
        messageHost.classList.toggle("empty-state", !messages.length);
        messageHost.innerHTML = messages.length
          ? messages
              .map(
                m =>
                  `<article class="contact-message"><p class="eyebrow">${escapeHtml(m.createdAt || "")}</p><h3>${escapeHtml(m.name)} · ${escapeHtml(m.email)}</h3><p>${escapeHtml(m.message)}</p></article>`
              )
              .join("")
          : "目前沒有聯絡訊息。";
      })
      .catch(error => {
        messageHost.textContent = error.message;
      });
  const accountHost = $("[data-account-content]");
  if (accountHost)
    api("/api/account")
      .then(data => {
        const bookings = (data.bookings || [])
          .map(
            b =>
              `<div class="service-row"><div><h2>${escapeHtml(b.serviceName || "預約服務")}</h2><p>${escapeHtml(localDate(b.startsAt))}</p></div><span>${escapeHtml(bookingLabel(b.status))}</span></div>`
          )
          .join("");
        const orders = (data.orders || [])
          .map(o => `<article class="order-receipt"><h2>訂單 ${escapeHtml(o.number || "")}</h2><p>${escapeHtml(paymentLabel(o.paymentStatus))} · ${escapeHtml(fulfillmentLabel(o.fulfillmentStatus))}</p><ul>${(o.items || []).map(item => `<li>${escapeHtml(item.name)}${item.variantLabel ? ` · ${escapeHtml(item.variantLabel)}` : ""} × ${escapeHtml(item.quantity)}</li>`).join("")}</ul><p>合計 ${formatMoney(o.totalMinor || 0)}</p>${(o.tracking || []).map(event => `<p>${escapeHtml(event.label || "物流更新")} · ${escapeHtml(event.createdAt || "")}${event.metadata?.carrier ? ` · ${escapeHtml(event.metadata.carrier)} ${escapeHtml(event.metadata.trackingNumber || "")}` : ""}</p>`).join("")}</article>`)
          .join("");
        const isCommerce = data.siteType === "commerce";
        accountHost.innerHTML = `${isCommerce ? `<section><h2>我的訂單</h2>${data.emailVerificationRequired ? '<p class="empty-state">完成電子郵件驗證後即可查看會員訂單。</p>' : orders || '<p class="empty-state">目前沒有訂單。</p>'}</section>` : `<section class="account-summary"><h2>可用堂數</h2><p>${escapeHtml(data.balance?.balance ?? data.balance ?? 0)} 堂</p></section><section><h2>我的預約</h2>${bookings || '<p class="empty-state">目前沒有預約。</p>'}</section>`}<form data-logout-form><button class="button button-small">登出</button><p class="form-message" aria-live="polite"></p></form>`;
        submit($("[data-logout-form]"), async (_, form) => {
          await api("/api/auth/logout", { method: "POST", body: {} });
          sessionPromise = undefined;
          location.assign("/");
        });
      })
      .catch(error => {
        accountHost.textContent = error.message;
      });
  $$("[data-credit-form]").forEach(form =>
    submit(form, async (data, node) => {
      data.delta = Number(data.delta);
      data.idempotencyKey = crypto.randomUUID();
      await api("/api/admin/credits", { method: "POST", body: data });
          say(node, "堂數已更新。");
    })
  );
  $$("[data-confirm-guest], [data-reject-guest]").forEach(button =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const bookingId =
          button.dataset.confirmGuest || button.dataset.rejectGuest;
        const action = button.dataset.confirmGuest ? "confirm" : "reject";
        await api(`/api/admin/bookings/${encodeURIComponent(bookingId)}`, {
          method: "PATCH",
          body: { action },
        });
        location.reload();
      } catch (error) {
        button.disabled = false;
        const message = $("[data-admin-message]");
        if (message) message.textContent = error.message;
      }
    })
  );
  updateCart();
})();
