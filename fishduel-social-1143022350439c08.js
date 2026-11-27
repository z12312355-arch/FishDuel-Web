window.installFishDuelSocial = function (connectAuth, googleLogin) {
  const panel = document.getElementById("social-panel");
  const content = panel.querySelector(".social-content");
  const notice = panel.querySelector("output");
  let client, anonymous, roster, busy = false;
  let inviteListener, pollTimer, pollGeneration = 0;

  async function pollInvites() {
    if (!inviteListener || document.hidden || panel.open) return;
    const generation = ++pollGeneration;
    try {
      const connection = await connectAuth();
      const {data, error} = await connection.client.auth.getSession();
      if (generation !== pollGeneration || error) return;
      if (!data.session) {
        inviteListener(false);
        return;
      }
      const result = await connection.client.rpc("fishduel_social", {action:"list"});
      if (generation === pollGeneration && !result.error) {
        inviteListener(result.data.people.some(person => person.state === "received"));
      }
    } catch {
      // Keep the last known status until connectivity returns.
    }
  }
  function stopWatching() {
    ++pollGeneration;
    clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", pollInvites);
    inviteListener = null;
  }
  document.getElementById("social-close").onclick = () => panel.close();

  function add(parent, tag, text = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  }
  function group(title) {
    const section = add(content, "section");
    add(section, "h3", title);
    return section;
  }
  function button(parent, title, fn) {
    const b = add(parent, "button", title);
    b.onclick = () => perform(fn);
  }
  async function perform(fn) {
    if (busy) return;
    busy = true;
    content.inert = true;
    notice.textContent = "處理中…";
    try {
      notice.textContent = await fn() || "";
    } catch (e) {
      const messages = {unknown_id:"找不到這位玩家，請核對好友 ID。",self:"這是你自己的 ID。",
        rate_limit:"本小時邀請已達上限，請稍後再試。",relationship_changed:"好友狀態已變更，請重新整理。"};
      notice.textContent = messages[e.message] || "連線失敗或服務暫未開放，請稍後再試。";
      button(content, "重新整理", start);
    } finally { busy = false; content.inert = false; }
  }
  async function rpc(action, args = {}) {
    const {data, error} = await client.rpc("fishduel_social", {action, ...args});
    if (error) throw error;
    return data;
  }
  async function change(action, target, message) {
    await rpc(action, {target_id:target});
    await refresh();
    return message;
  }
  async function start() {
    content.replaceChildren();
    const connection = await connectAuth();
    client = connection.client;
    const {data, error} = await client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      const settings = await fetch(connection.config.url + "/auth/v1/settings", {
        headers:{apikey:connection.config.key}, signal:AbortSignal.timeout(8000)
      }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!settings?.external?.anonymous_users) {
        add(content,"p","使用 Google 登入即可取得好友 ID。訪客進度保存在這台裝置，清除瀏覽器資料可能會遺失。");
        button(content,"使用 Google 登入",googleLogin);
        return;
      }
      add(content,"p","啟用訪客好友 ID 後即可加好友。清除瀏覽器資料可能失去這個帳號。");
      button(content,"啟用訪客好友 ID", async () => {
        const result = await client.auth.signInAnonymously();
        if (result.error?.code === "anonymous_provider_disabled") {
          content.replaceChildren();
          add(content,"p","目前訪客進度保存在這台裝置。使用 Google 登入即可取得好友 ID。");
          button(content,"使用 Google 登入",googleLogin);
          return;
        }
        if (result.error) throw result.error;
        await start();
      });
      button(content,"使用 Google 登入",googleLogin);
      return;
    }
    anonymous = data.session.user.is_anonymous === true;
    await refresh();
  }
  async function refresh() {
    const mine = await rpc("list");
    ++pollGeneration;
    inviteListener?.(mine.people.some(person => person.state === "received"));
    content.replaceChildren();
    const info = group(mine.name);
    add(info,"p","好友 ID　" + (mine.id.length === 8 ? mine.id.slice(0,4) + " " + mine.id.slice(4) : mine.id));
    button(info,"複製 ID", async () => { await navigator.clipboard.writeText(mine.id); return "已複製好友 ID"; });
    button(info,"重新整理",refresh);
    if (anonymous) {
      add(info,"p","清除瀏覽器資料可能失去訪客帳號。");
      button(info,"綁定 Google",googleLogin);
    }

    const find = group("新增好友");
    const input = add(find,"input");
    input.placeholder = "輸入好友 ID";
    input.setAttribute("aria-label",input.placeholder);
    input.maxLength = 20;
    const result = document.createElement("div");
    button(find,"搜尋",async () => {
      result.replaceChildren();
      const player = await rpc("search",{target_id:input.value.trim()});
      add(result,"strong",player.name);
      const existing = mine.people.find(p => p.id === player.id);
      if (existing) add(result,"span",existing.state === "friend" ? "　已是好友" : "　已有邀請");
      else button(result,"發送邀請",() => change("invite",player.id,"已送出邀請"));
    });
    find.append(result);

    for (const [state,title,empty] of [["received","收到邀請","目前沒有邀請"],["sent","已送出","沒有待回覆邀請"],["friend","我的好友","還沒有好友"]]) {
      const section = group(title);
      const people = mine.people.filter(p => p.state === state);
      if (!people.length) add(section,"small",empty);
      for (const p of people) {
        const row = add(section,"div");
        add(row,"h4",p.name);
        if (state === "received") {
          button(row,"接受",() => change("accept",p.id,"已成為好友"));
          button(row,"拒絕",() => change("reject",p.id,"已拒絕邀請"));
        } else if (state === "sent") button(row,"取消邀請",() => change("cancel",p.id,"已取消邀請"));
        else {
          add(row,"p",p.fish ? p.fish.name + " · " + p.fish.rating : "尚未設定代表魚");
          if (p.fish?.attributes) {
            const details = add(row,"details");
            add(details,"summary","查看代表魚");
            add(details,"p",p.fish.attributes.map((v,i) => ["力量","耐久","機動","必殺"][i] + " " + v).join("　"));
            add(details,"p","技能　" + (p.fish.skills.join("、") || "尚無技能"));
          }
          button(row,"刪除好友",() => window.confirm("將「" + p.name + "」從好友名單移除？") ? change("remove",p.id,"已刪除好友") : "");
        }
      }
    }
    const profile = group("我的代表魚");
    const select = add(profile,"select");
    select.setAttribute("aria-label","代表魚");
    const current = add(select,"option",mine.fish ? "保留：" + mine.fish.name : "不展示代表魚");
    current.value = "current";
    if (mine.fish) add(select,"option","不展示代表魚").value = "none";
    roster.forEach((f,i) => { add(select,"option",f.name + " · " + f.rating).value = String(i); });
    const label = add(profile,"label");
    const check = add(label,"input");
    check.type = "checkbox"; check.checked = mine.share;
    label.append("好友可查看屬性與技能");
    button(profile,"儲存",async () => {
      const card = select.value === "current" ? mine.fish : roster[Number(select.value)] ?? null;
      await rpc("profile",{card,share:check.checked});
      await refresh();
      return "代表魚設定已儲存";
    });
  }
  window.fishDuelSocial = {
    watchInvites(listener) {
      if (inviteListener === listener) return;
      stopWatching();
      inviteListener = listener;
      void pollInvites();
      pollTimer = setInterval(pollInvites, 60000);
      document.addEventListener("visibilitychange", pollInvites);
    },
    unwatchInvites(listener) {
      if (inviteListener === listener) stopWatching();
    },
    open(json) {
      if (panel.open || busy) return;
      roster = JSON.parse(json);
      panel.showModal();
      perform(start);
    }
  };
};
