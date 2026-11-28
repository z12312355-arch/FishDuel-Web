window.installFishDuelSocial = function (connectAuth, googleLogin) {
  const panel = document.getElementById("social-panel");
  const content = panel.querySelector(".social-content");
  const notice = panel.querySelector("output");
  const nav = panel.querySelector("nav");
  let client, anonymous, roster, busy = false;
  let mine, breeding, onBreed, view = "friends";
  let duelAction, duels = [];
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
      if(window.fishDuelCloud?.breedRequest) await window.fishDuelCloud.breedRequest({action:"list"}).catch(()=>{});
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
    return b;
  }
  async function perform(fn) {
    if (busy) return;
    busy = true;
    content.inert = true;
    nav.inert = true;
    notice.textContent = "處理中…";
    try {
      notice.textContent = await fn() || "";
    } catch (e) {
      const messages = {unknown_id:"找不到這位玩家，請核對好友 ID。",self:"這是你自己的 ID。",
        rate_limit:"本小時邀請已達上限，請稍後再試。",relationship_changed:"好友狀態已變更，請重新整理。"};
      notice.textContent = messages[e.message] || "連線失敗或服務暫未開放，請稍後再試。";
      if (!messages[e.message] && !content.querySelector(".social-retry")) {
        button(content, "重試連線", start).className = "social-retry";
      }
    } finally { busy = false; content.inert = false; nav.inert = false; }
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
    nav.hidden = true;
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
    mine = await rpc("list");
    breeding = !anonymous && window.fishDuelCloud?.breedRequest ? await window.fishDuelCloud.breedRequest({action:"list"}).catch(()=>null) : null;
    duels = [];
    if (duelAction && !anonymous && window.fishDuelFriends?.mobileSettlement) {
      const response = await new Promise(resolve => window.fishDuelFriends.sendRequest("direct_pending","{}",raw => resolve(JSON.parse(raw))));
      duels = response.items || [];
    }
    ++pollGeneration;
    const pending = mine.people.filter(person => person.state === "received").length;
    inviteListener?.(pending > 0);
    nav.replaceChildren();
    nav.hidden = false;
    for (const [key,title] of [["friends","名單"],["invites",pending ? "邀請 " + pending : "邀請"],["search","加好友"],["profile","代表魚"]]) {
      const item = add(nav,"button",title);
      item.dataset.view = key;
      item.onclick = () => show(key);
    }
    show(view);
  }
  function show(key) {
    view = key;
    for (const item of nav.children) {
      if (item.dataset.view === key) item.setAttribute("aria-current","page");
      else item.removeAttribute("aria-current");
    }
    notice.textContent = "";
    content.replaceChildren();
    content.scrollTop = 0;
    if (key === "friends") friendList();
    if (key === "invites") invitations();
    if (key === "search") searchPage();
    if (key === "profile") profilePage();
  }
  function searchPage() {
    const info = group("我的好友 ID");
    const idRow = add(info,"div");
    idRow.className = "social-row";
    add(idRow,"span",mine.id.length === 8 ? mine.id.slice(0,4) + " " + mine.id.slice(4) : mine.id).className = "social-id";
    button(idRow,"複製 ID",async () => {
      try { await navigator.clipboard.writeText(mine.id); return "已複製好友 ID"; }
      catch { return "請長按或選取上方 ID 複製。"; }
    });
    const find = group("搜尋玩家");
    const form = add(find,"form");
    form.className = "social-row";
    const input = add(form,"input");
    input.placeholder = "輸入好友 ID";
    input.setAttribute("aria-label",input.placeholder);
    input.maxLength = 20;
    input.required = true;
    input.autocomplete = "off";
    input.spellcheck = false;
    add(form,"button","搜尋").className = "social-primary";
    const result = add(find,"div");
    result.setAttribute("aria-live","polite");
    form.onsubmit = event => {
      event.preventDefault();
      perform(async () => {
        result.replaceChildren();
        const player = await rpc("search",{target_id:input.value.replace(/\s/g,"")});
        const row = add(result,"div");
        row.className = "social-card";
        add(row,"strong",player.name);
        const existing = mine.people.find(p => p.id === player.id);
        if (existing) add(row,"span",existing.state === "friend" ? "已是好友" : "已有邀請");
        else button(row,"發送邀請",() => change("invite",player.id,"已送出邀請")).className = "social-primary";
      });
    };
  }
  function invitations() {
    for (const [state,title,empty] of [["received","收到的邀請","目前沒有收到邀請"],["sent","已送出","沒有待回覆邀請"]]) {
      const section = group(title);
      const people = mine.people.filter(p => p.state === state);
      if (!people.length) add(section,"small",empty);
      for (const p of people) {
        const row = add(section,"div");
        row.className = "social-card";
        add(row,"strong",p.name);
        const actions = add(row,"div");
        actions.className = "social-row";
        if (state === "received") {
          button(actions,"接受",() => change("accept",p.id,"已成為好友")).className = "social-primary";
          button(actions,"拒絕",() => change("reject",p.id,"已拒絕邀請"));
        } else button(actions,"取消邀請",() => change("cancel",p.id,"已取消邀請"));
      }
    }
    button(content,"重新整理",refresh);
  }
  function friendList() {
    const friends = mine.people.filter(p => p.state === "friend");
    const list = group("我的好友 · " + friends.length);
    if (!friends.length) {
      add(list,"p","還沒有好友。用好友 ID 找到一起養魚的朋友吧。");
      const find = add(list,"button","新增好友");
      find.className = "social-primary";
      find.onclick = () => { show("search"); content.querySelector("input").focus(); };
    }
    for (const p of friends) {
      const pair = add(list,"div");
      pair.className = "social-friend-row";
      const row = add(pair,"button");
      row.className = "social-card";
      row.dataset.id = p.id;
      add(row,"strong",p.name);
      add(row,"span",p.fish ? p.fish.name + " · 評價 " + p.fish.rating : "尚未設定代表魚").className = "social-muted";
      row.onclick = () => friendDetails(p,content.scrollTop);
      if (duelAction && !anonymous && window.fishDuelFriends?.mobileSettlement) {
        const matches = duels.filter(m => m.peer_id === p.id);
        const pending = matches.find(m => m.side !== 0) || matches[0];
        const duel = add(pair,"button",pending ? (pending.side === 0 ? "查看約戰" : "前往應戰") : "邀請對戰");
        duel.setAttribute("aria-label",duel.textContent + " · " + p.name);
        duel.onclick = () => {
          panel.close();
          duelAction(p.id,p.name,pending?.code || "");
        };
      }
    }
    button(content,"重新整理",refresh);
  }
  function friendDetails(p,scrollPosition) {
    content.replaceChildren();
    notice.textContent = "";
    content.scrollTop = 0;
    const back = add(content,"button","返回名單");
    back.onclick = () => {
      show("friends");
      content.scrollTop = scrollPosition;
      Array.from(content.querySelectorAll("[data-id]")).find(row => row.dataset.id === p.id)?.focus({preventScroll:true});
    };
    back.focus();
    const section = group(p.name);
    if (p.fish) {
      add(section,"strong",p.fish.name + " · 評價 " + p.fish.rating);
      if (p.fish.attributes) {
        p.fish.attributes.forEach((value,i) => {
          const stat = ["力量","耐久","機動","必殺"][i];
          const line = add(section,"div");
          line.className = "social-stat";
          add(line,"span",stat);
          const bar = add(line,"progress");
          bar.max = 120;
          bar.value = value;
          bar.setAttribute("aria-label",stat);
          bar.style.setProperty("--stat",["#e47c65","#be9fd6","#77c3d6","#edc66f"][i]);
          add(line,"span",String(value));
        });
        add(section,"p","技能　" + (p.fish.skills.join("、") || "尚無技能"));
      } else add(section,"p","這位好友只公開了代表魚的名稱和評價。").className = "social-muted";
    } else add(section,"p","尚未設定代表魚");
    const offered = breeding?.offers.find(f=>f.id===p.id);
    if (offered && onBreed) {
      const eligible = roster.some(f=>f.parent && f.species===offered.species);
      if (!eligible) add(section,"p","完成並保存一條同種魚的育成後，就能與牠配對。");
      const use = add(section,"button","與這條魚配對");
      use.disabled = !eligible;
      use.onclick = ()=>{panel.close();onBreed(p.id);};
    }
    button(section,"刪除好友",() => window.confirm("將「" + p.name + "」從好友名單移除？") ? change("remove",p.id,"已刪除好友") : "");
  }
  function profilePage() {
    const profile = group("我的代表魚");
    add(profile,"p",mine.name).className = "social-muted";
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
    const permit = add(profile,"label");
    const open = add(permit,"input");
    open.type="checkbox";
    open.checked=!!breeding?.mine;
    permit.append("開放好友配對");
    permit.hidden=!breeding;
    const explanation=add(profile,"p","好友可查看魚像、魚色、體型及成長強項。孩子由好友帶回，成功配對可得 10 金幣；每對好友每日限領一次，每日最多 30 金幣。");
    explanation.hidden=!breeding;
    const hint=add(profile,"small","請先從上方名單選一條已完成育成的代表魚。");
    const selectedFish=()=>select.value==="current" ? roster.find(f=>f.id===breeding?.mine) : roster[Number(select.value)];
    function updatePermit(){
      open.disabled=!selectedFish()?.parent;
      hint.hidden=!breeding || !open.disabled;
      if(open.disabled) open.checked=false;
    }
    select.onchange=()=>{open.checked=false;updatePermit();};
    updatePermit();
    if(breeding?.recent?.length){
      const history=group("最近好友配對");
      for(const item of breeding.recent) add(history,"p",item.player+" 選了"+(item.parent_name||"你的代表魚")+"，"+(item.births>1?"誕生了 "+item.births+" 條小魚":"誕生了"+item.child_name)+"　＋"+item.amount+" 金幣");
    }
    button(profile,"儲存",async () => {
      const card = select.value === "current" ? mine.fish : roster[Number(select.value)] ?? null;
      if(open.checked && breeding) {
        await window.fishDuelCloud.breedRequest({action:"publish",fish:selectedFish().id,share:check.checked});
      } else if (breeding?.mine && select.value === "current") {
        await window.fishDuelCloud.breedRequest({action:"withdraw",share:check.checked});
      } else {
        const snapshot=card ? {name:card.name,rating:card.rating,attributes:card.attributes,skills:card.skills} : null;
        await rpc("profile",{card:snapshot,share:check.checked});
      }
      await refresh();
      return "代表魚設定已儲存";
    }).className = "social-primary";
    if (anonymous) {
      add(content,"p","清除瀏覽器資料可能失去訪客帳號。");
      button(content,"綁定 Google",googleLogin);
    }
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
    open(json, onDuel, onPair) {
      if (panel.open || busy) return;
      roster = JSON.parse(json);
      duelAction = onDuel;
      onBreed = onPair;
      view = "friends";
      panel.showModal();
      perform(start);
    }
  };
};
