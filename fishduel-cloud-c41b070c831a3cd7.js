const element = (id) => document.getElementById(id);
const message = element("message");
const status = element("save-state");
const signIn = element("sign-in");
const switchAccount = element("switch-account");
const enterGame = element("enter-game");
const retry = element("retry");
const guestPlay = element("guest-play");
const guestImport = element("guest-import");
const guestSkip = element("guest-skip");
const guestNote = element("guest-note");
const productionSite = "https://myfishking.vercel.app/";
const legacyOrigin = "https://z12312355-arch.github.io";
const inviteKey = "fishduel-friend-invite";
const authStorageKey = "fishduel-google-session";
const inviteCode = new URL(location.href).searchParams.get("duel")?.toUpperCase();
const hasInvite = /^[0-9A-F]{10}$/.test(inviteCode || "");
const guestKey = "fishduel-guest-save";
const guestLock = "fishduel-play-guest";
const saveLimit = 2097152;
let connecting;
retry.onclick = () => location.reload();
window.addEventListener("pageshow", event => {
  if (event.persisted) location.reload();
});

function saveWarning(text) {
  status.textContent = text;
  status.hidden = false;
}

window.installFishDuelSocial?.(connectAuth, googleLogin);

function connectAuth() {
  if (!connecting) {
    connecting = (async () => {
      const config = await fetch("./cloud-config.json", {
        cache: "no-store", signal: AbortSignal.timeout(8000)
      }).then(response => response.json());
      if (!config.url || !config.key) throw new Error("Missing cloud configuration");
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.95.3/+esm");
      const client = createClient(config.url, config.key, {
        auth: { flowType: "pkce", storageKey: authStorageKey, detectSessionInUrl: false }
      });
      return { client, config };
    })().catch(error => {
      connecting = null;
      throw error;
    });
  }
  return connecting;
}

async function googleLogin() {
  const { client } = await connectAuth();
  const current = await client.auth.getSession();
  if (current.error) throw current.error;
  const method = current.data.session?.user?.is_anonymous ? "linkIdentity" : "signInWithOAuth";
  const { error } = await client.auth[method]({
    provider: "google",
    options: { redirectTo: new URL("./", location.href).href, queryParams: { prompt: "select_account" } }
  });
  if (error) throw error;
}

function showGoogleLogin(prompt = "立即試玩，或使用 Google 登入同步進度。", allowGuest = true) {
  message.textContent = prompt;
  signIn.hidden = false;
  signIn.classList.toggle("secondary", allowGuest);
  guestPlay.hidden = !allowGuest;
  guestNote.hidden = !allowGuest;
  signIn.onclick = async () => {
    signIn.disabled = true;
    guestPlay.disabled = true;
    try {
      await googleLogin();
    } catch {
      message.textContent = "無法開啟 Google 登入，請再試一次。";
      signIn.disabled = false;
      guestPlay.disabled = false;
    }
  };
}

function readGuest() {
  const raw = localStorage.getItem(guestKey);
  if (raw === null) return null;
  const guest = JSON.parse(raw);
  if (!guest || typeof guest.payload !== "string" || !guest.payload || guest.payload.length > saveLimit) {
    throw new Error("Invalid guest save");
  }
  return guest;
}

function writeGuest(guest) {
  localStorage.setItem(guestKey, JSON.stringify(guest));
}

guestPlay.onclick = async () => {
  guestPlay.disabled = true;
  signIn.disabled = true;
  try {
    await navigator.locks.request(guestLock, { ifAvailable: true }, async lock => {
      if (!lock) {
        message.textContent = "試玩已在另一個分頁開啟，請先關閉該分頁。";
        return;
      }
      let guest = readGuest();
      if (guest?.transfer && !guest.transfer.closed) {
        message.textContent = "上次的轉移尚待確認。請使用當時的 Google 帳號登入。";
        return;
      }
      // Confirm browser storage is writable before allowing a new game.
      const probe = guestKey + ":check";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      signIn.hidden = true;
      guestPlay.hidden = true;
      window.fishDuelCloud = {
        guest: true, playbackAdmin: false, gameAdmin: false, toolsMode: false,
        getSave: () => guest?.payload ?? "",
        requestSignOut: () => location.assign(new URL("./", location.href).href),
        async requestSignIn() {
          try { await googleLogin(); }
          catch { saveWarning("無法開啟 Google 登入，試玩進度仍保存在此瀏覽器。"); }
        },
        queueSave(payload) {
          if (!payload || payload.length > saveLimit) return false;
          try {
            const next = { ...guest, payload };
            writeGuest(next);
            guest = next;
            status.hidden = true;
            return true;
          } catch {
            saveWarning("無法寫入瀏覽器，請先確認瀏覽器的儲存空間和設定。");
            return false;
          }
        }
      };
      if (await startGame()) await new Promise(() => {});
    });
  } catch {
    message.textContent = "無法讀寫這個瀏覽器的試玩存檔。";
  } finally {
    guestPlay.disabled = false;
    signIn.disabled = false;
  }
};

async function boot() {
  const callback = new URL(location.href);
  // Start OAuth on the destination origin so PKCE can use the same browser storage on return.
  if (callback.origin === legacyOrigin) {
    const destination = new URL(productionSite);
    if (hasInvite) destination.searchParams.set("duel", inviteCode);
    location.replace(destination.href);
    return;
  }
  if (hasInvite) sessionStorage.setItem(inviteKey, inviteCode);
  const code = callback.searchParams.get("code");
  const callbackError = callback.searchParams.has("error") || new URLSearchParams(callback.hash.slice(1)).has("error");
  if (code || callbackError) history.replaceState(null, "", callback.pathname);
  const loginPrompt = sessionStorage.getItem(inviteKey) ? "使用 Google 登入後即可接受好友挑戰。" : undefined;
  if (!code && !callbackError && !localStorage.getItem(authStorageKey)) {
    showGoogleLogin(loginPrompt);
    return;
  }
  const { client, config } = await connectAuth();
  if (code || callbackError) {
    const result = code && !callbackError ? await client.auth.exchangeCodeForSession(code) : null;
    if (!result?.data?.session || result.error) {
      showGoogleLogin("登入連結已失效，請重新使用 Google 登入。");
      return;
    }
  }
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session) {
    showGoogleLogin(loginPrompt);
    return;
  }
  const account = session.user.id;
  if (session.user.is_anonymous) {
    showGoogleLogin("繼續試玩，或綁定 Google 以便跨裝置找回好友。");
    return;
  }
  const { data: verified, error: claimsError } = await client.auth.getClaims(session.access_token);
  if (claimsError) throw claimsError;
  const claims = verified?.claims;
  const googleOAuth = claims?.sub === account
    && claims.app_metadata?.providers?.includes("google")
    && claims.amr?.some(entry => entry.method === "oauth");
  if (!googleOAuth) {
    const { error: signOutError } = await client.auth.signOut({ scope: "local" });
    if (signOutError) throw signOutError;
    showGoogleLogin("請使用 Google 帳號登入遊戲。");
    return;
  }
  switchAccount.hidden = false;
  switchAccount.textContent = "切換帳號";
  switchAccount.onclick = async () => {
    enterGame.disabled = true;
    switchAccount.disabled = true;
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      location.reload();
    } catch {
      message.textContent = "無法切換帳號，請稍後再試。";
      switchAccount.disabled = false;
      enterGame.disabled = false;
    }
  };
  message.textContent = sessionStorage.getItem(inviteKey) ? "進入遊戲後可查看好友挑戰。" : "";
  enterGame.hidden = false;
  await new Promise(resolve => {
    enterGame.onclick = () => {
      if (enterGame.disabled) return;
      enterGame.disabled = true;
      enterGame.hidden = true;
      enterGame.onclick = null;
      switchAccount.disabled = true;
      message.textContent = "正在讀取遊戲進度…";
      resolve();
    };
  });
  await navigator.locks.request("fishduel-play-" + account, { ifAvailable: true }, async lock => {
    if (!lock) {
      message.textContent = "這個帳號已在另一個分頁開啟。關閉該分頁後再重新載入。";
      switchAccount.disabled = false;
      retry.hidden = false;
      return;
    }
    let playbackAdmin = false;
    if (session.user.app_metadata?.fishduel_playback_admin === true) {
      const { data } = await client.auth.getUser();
      playbackAdmin = data?.user?.id === account && data.user.app_metadata?.fishduel_playback_admin === true;
    }
    let gameAdmin = false;
    try {
      const { data, error } = await client.rpc("fishduel_is_game_admin").abortSignal(AbortSignal.timeout(3500));
      gameAdmin = !error && data === true;
    } catch { /* Fail closed and still allow normal play. */ }
    const toolsMode = gameAdmin && new URL(location.href).searchParams.get("tools") === "1";
    switchAccount.disabled = false;
    await prepareGame(client, account, config.duelApi, playbackAdmin || gameAdmin, gameAdmin, toolsMode);
    // Keep the lock until this page is closed or reloaded.
    await new Promise(() => {});
  });
}

function chooseGuestTransfer(canImport, prompt) {
  message.textContent = prompt;
  guestImport.hidden = !canImport;
  guestSkip.hidden = false;
  guestSkip.textContent = canImport ? "略過轉移" : "繼續遊戲";
  return new Promise(resolve => {
    function choose(importSave) {
      guestImport.hidden = true;
      guestSkip.hidden = true;
      resolve(importSave);
    }
    guestImport.onclick = () => choose(true);
    guestSkip.onclick = () => choose(false);
  });
}

async function withGuestTransfer(account, cloud, pending, play) {
  await navigator.locks.request(guestLock, { ifAvailable: true }, async lock => {
    let guest;
    if (!lock && !cloud && !pending) {
      message.textContent = "請先關閉正在試玩的分頁，再重新載入以轉移進度。";
      retry.hidden = false;
      return;
    }
    try { if (lock) guest = readGuest(); }
    catch { /* A broken local trial must never block the account save. */ }
    if (!guest) return play();
    const transfer = guest.transfer;
    if (transfer?.account === account && cloud?.request_id === transfer.id && cloud.payload === guest.payload) {
      try { localStorage.removeItem(guestKey); } catch {}
      return play();
    }
    if (cloud || pending || transfer?.closed || (transfer && transfer.account !== account)) {
      if (cloud && transfer?.account === account && !transfer.closed) {
        // The first-write race was lost, or another device already advanced
        // the cloud save. Preserve the local copy as trial-only.
        writeGuest({ ...guest, transfer: { ...transfer, closed: true } });
      }
      await chooseGuestTransfer(false, cloud || pending
        ? "此帳號已有進度。試玩進度會留在此瀏覽器。"
        : "這份試玩進度無法轉移至目前帳號，仍保存在此瀏覽器。");
      return play();
    }
    const accepted = await chooseGuestTransfer(true, "這個 Google 帳號還沒有存檔。要轉移此瀏覽器的試玩進度嗎？");
    return play(accepted ? guest : null);
  });
}

async function prepareGame(client, account, duelApi, playbackAdmin, gameAdmin, toolsMode) {
  let cloud;
  if (!toolsMode) {
    const { data, error } = await client.from("fishduel_save")
      .select("revision,request_id,payload").eq("player", account).maybeSingle();
    if (error) throw error;
    cloud = data;
  }
  const storageKey = "fishduel-outbox:" + account;
  const pending = toolsMode ? null : JSON.parse(localStorage.getItem(storageKey) ?? "null");
  const play = guest => runAccountGame(client, account, duelApi, playbackAdmin, gameAdmin, toolsMode, cloud, storageKey, pending, guest);
  if (toolsMode) await play();
  else await withGuestTransfer(account, cloud, pending, play);
}

async function runAccountGame(client, account, duelApi, playbackAdmin, gameAdmin, toolsMode, cloud, storageKey, pending, guest) {
  let revision = cloud?.revision ?? 0;
  let current = pending?.next ?? pending?.payload ?? cloud?.payload ?? "";
  let sending = false;
  let conflict = false;
  let active = true;
  let resetting = false;

  function persist(next) {
    if (next) localStorage.setItem(storageKey, JSON.stringify(next));
    else localStorage.removeItem(storageKey);
    pending = next;
  }

  function advance(nextRevision) {
    revision = nextRevision;
    persist(pending.next ? {
      expected: revision, id: crypto.randomUUID(), payload: pending.next
    } : null);
  }

  function showConflict() {
    conflict = true;
    saveWarning("另一台裝置已更新進度。");
    const reload = document.createElement("button");
    reload.textContent = "載入雲端進度";
    reload.onclick = () => {
      if (confirm("要捨棄這個瀏覽器尚未同步的進度，並載入雲端存檔嗎？")) {
        persist(null);
        location.reload();
      }
    };
    status.append(" ", reload);
  }

  if (pending && cloud?.request_id === pending.id) advance(revision);
  if (pending && pending.expected !== revision) showConflict();

  async function sync() {
    if (sending || conflict || !pending || !active) return;
    sending = true;
    try {
      const { data, error } = await client.rpc("write_fishduel_save_v2", {
        expected: pending.expected, operation: pending.id, contents: pending.payload
      }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (data === null) {
        showConflict();
        return;
      }
      advance(data);
      if (!pending) status.hidden = true;
      else setTimeout(sync, 0);
    } catch {
      saveWarning("進度暫存在這個瀏覽器，稍後會重試同步。");
    } finally {
      sending = false;
    }
  }

  async function requestSignOut() {
    if (resetting) return;
    if (pending) {
      if (!confirm("這個瀏覽器還有進度尚未同步。確定要登出嗎？")) return;
    }
    active = false;
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      location.reload();
    } catch {
      active = true;
      saveWarning("登出失敗，請再試一次。");
    }
  }

  function openTools() {
    if (!gameAdmin || resetting) return;
    if (pending || sending || conflict) {
      saveWarning("請等候雲端存檔同步後再開啟測試工具。");
      return;
    }
    const url = new URL("./", location.href);
    url.searchParams.set("tools", "1");
    location.assign(url.href);
  }

  async function requestReset() {
    if (!gameAdmin || toolsMode || resetting || !active) return;
    if (!current) {
      saveWarning("這個帳號還沒有進度可以重置。");
      return;
    }
    if (!confirm("要重置目前登入帳號的魚隻與遊戲進度嗎？")) return;
    if (prompt("這只會重置你自己的存檔。輸入「重置」並確認，重新開始遊戲。") !== "重置") return;
    await sync();
    if (pending || sending || conflict || resetting || !active) {
      saveWarning("請先完成目前的雲端存檔同步。");
      return;
    }
    resetting = true;
    try {
      const { data: auth } = await client.auth.getSession();
      if (auth.session?.user.id !== account) throw new Error();
      const run = confirmation_code => client.rpc("fishduel_admin_reset_own", {
        expected_revision: revision, confirmation_code
      }).abortSignal(AbortSignal.timeout(12000));
      const prepared = await run(null);
      if (prepared.error || prepared.data?.status !== "confirm" || !prepared.data.token) throw new Error();
      const result = await run(prepared.data.token);
      if (result.error || result.data?.status !== "done") throw new Error();
      active = false;
      location.assign(new URL("./", location.href).href);
    } catch {
      saveWarning("無法確認重置。請重新載入，查看最新雲端進度。");
    } finally {
      resetting = false;
    }
  }

  let displayName = "小魚友" + String(parseInt(account.slice(-8), 16) % 10000 || 0).padStart(4, "0");
  let nextRename = 0;
  let profileRequest = Promise.resolve();
  function nickname() {
    return { display_name: displayName, retry_after: Math.max(0, Math.ceil((nextRename - performance.now()) / 1000)) };
  }
  function requestNickname(newName = null, reply) {
    profileRequest = profileRequest.then(() => updateNickname(newName)).then(result => {
      try { reply?.(JSON.stringify(result)); } catch { /* Settings may have closed. */ }
    });
  }
  async function updateNickname(newName) {
    let failure = "";
    try {
      const { data: auth } = await client.auth.getSession();
      if (!active || auth.session?.user.id !== account) throw new Error();
      const { data, error } = await client.rpc("fishduel_player_profile", { new_name: newName })
        .abortSignal(AbortSignal.timeout(8000));
      if (error || typeof data?.display_name !== "string" || !Number.isInteger(data.retry_after)) throw new Error();
      if (active) {
        displayName = data.display_name;
        nextRename = performance.now() + data.retry_after * 1000;
      }
      failure = data.error || "";
    } catch {
      failure = "unavailable";
    }
    return { ...nickname(), error: failure };
  }
  if (!toolsMode) {
    window.fishDuelPlayer = { nickname, displayName: () => displayName, requestNickname };
    void requestNickname(null);
  }

  const affection = new Map();
  const appetite = new Map();
  let walletState = null;
  function rememberFish(id, state) {
    affection.set(id, state.affection);
    appetite.set(id, {satiety:state.satiety, next:performance.now() + state.until_decay * 1000});
  }
  async function careRpc(name, params) {
    const {data: auth} = await client.auth.getSession();
    if (!active || auth.session?.user.id !== account || toolsMode) throw new Error("unavailable");
    let {data, error} = await client.rpc(name, params).abortSignal(AbortSignal.timeout(8000));
    if (active && ((name === "fishduel_care_fish" && error?.code === "P0002") ||
        (name === "fishduel_care_shop" && error?.message === "wallet_migration_pending"))) {
      await sync();
      await settleAccount();
      ({data,error} = await client.rpc(name,params).abortSignal(AbortSignal.timeout(8000)));
    }
    if (error || !active) throw new Error(error?.message || "unavailable");
    return data;
  }
  let settlementRequest;
  async function settleAccount() {
    if (!settlementRequest) settlementRequest = (async () => {
      const {data} = await client.auth.getSession();
      if (!active || toolsMode || data.session?.user.id !== account) throw new Error("unavailable");
      const {error} = await client.functions.invoke("care-settle",{body:{}});
      if (error) throw new Error("settling");
    })().finally(()=>{settlementRequest=null;});
    return settlementRequest;
  }
  async function careRequest(body, reply) {
    let result;
    try {
      const req = JSON.parse(body);
      if (req.action === "entry") {
        await sync();
        if (pending || sending || conflict) throw new Error("unavailable");
        await settleAccount();
        result = await careRpc("fishduel_care_entry", {entry_key:req.entry,stage:req.stage,target:req.id});
        affection.set(req.id, result.affection);
      } else if (req.action === "cast") {
        const key = "fishduel-care-cast:" + account;
        let tx = JSON.parse(localStorage.getItem(key) || "null");
        if (!tx) {
          await sync();
          if (sending || pending || conflict) throw new Error("unavailable");
          tx = {expected:revision, operation:crypto.randomUUID(), contents:req.payload, bait_kind:req.bait};
          localStorage.setItem(key, JSON.stringify(tx));
        }
        try {
          const saved = await careRpc("fishduel_care_cast", tx);
          if (saved !== tx.expected + 1) throw new Error("unavailable");
          revision = saved;
          current = tx.contents;
          localStorage.removeItem(key);
          result = {payload:current};
        } catch (error) {
          if (["no_stock", "stale_version"].includes(error.message)) localStorage.removeItem(key);
          throw error;
        }
      } else if (req.action === "pellet") {
        const before = await careRpc("fishduel_care_fish", {target:req.id});
        if (before.satiety >= 100) throw new Error("fish_full");
        result = await careRpc("fishduel_care_fish", {target:req.id,food_kind:"normal",expected_version:before.version});
        rememberFish(req.id,result);
      } else if (req.action === "fish") {
        result = await careRpc("fishduel_care_fish", {target:req.id, food_kind:req.food || null, expected_version:req.version ?? null});
        rememberFish(req.id, result);
      } else {
        const key = "fishduel-care-purchase:" + account;
        let pending = JSON.parse(localStorage.getItem(key) || "null");
        if (pending && req.food && (pending.product !== req.food || pending.quantity !== req.quantity)) {
          throw new Error("previous_purchase");
        }
        if (!pending && req.food) {
          pending = {operation:crypto.randomUUID(), product:req.food, quantity:req.quantity};
          localStorage.setItem(key, JSON.stringify(pending));
        }
        try {
          result = await careRpc("fishduel_care_shop", pending || {});
          walletState = result;
          if (pending) localStorage.removeItem(key);
        } catch (error) {
          if (["insufficient_coins","invalid_purchase","unknown_product"].includes(error.message)) localStorage.removeItem(key);
          throw error;
        }
      }
    } catch (error) {
      const messages = {settling:"上一場正在結算，請稍後再試。",previous_purchase:"上一筆訂單尚待確認，請重新整理。",cup_locked:"上一關的獎金正在結算，請稍後再試。",wait:"請稍候再挑戰。",fish_full:"已經吃飽囉。", no_stock:"飼料已用完。", stale_version:"餵食狀態已更新，請重新整理。", insufficient_coins:"金幣不足。", wallet_migration_pending:"金幣正在轉移，請稍後再試。"};
      result = {error: messages[error.message] || "暫時無法確認，請重新整理。"};
    }
    reply(JSON.stringify(result));
  }

  const finishKey = "fishduel-care-results:" + account;
  let settlingCare = false;
  async function finishCare(entry) {
    const read = () => JSON.parse(localStorage.getItem(finishKey) || "[]");
    if (entry && !read().includes(entry)) localStorage.setItem(finishKey, JSON.stringify([...read(),entry]));
    if (settlingCare) return;
    settlingCare = true;
    try {
      for (const key of read()) {
        await careRpc("fishduel_care_finish",{entry_key:key});
        await settleAccount();
        walletState = await careRpc("fishduel_care_shop",{});
        localStorage.setItem(finishKey,JSON.stringify(read().filter(value => value !== key)));
      }
    } catch { /* The next sync retries the same entries. */ }
    finally { settlingCare = false; }
  }
  setInterval(() => void finishCare(),8000);
  window.fishDuelCloud = {
    finishCare, guest:false, careWallet: () => JSON.stringify(walletState),
    careCanEat(id) {
      const state = appetite.get(id);
      return !state || state.satiety < 100 || performance.now() >= state.next;
    },
    careRequest, careAffection: id => affection.get(id) || 0,
    playbackAdmin, gameAdmin, toolsMode,
    getSave: () => current,
    requestSignOut,
    openTools,
    exitTools: () => location.assign(new URL("./", location.href).href),
    requestReset,
    queueSave(payload) {
      if (toolsMode || resetting || conflict || guest || !active || localStorage.getItem("fishduel-care-cast:" + account) || !payload || payload.length > saveLimit) return false;
      try {
        persist(pending ? { ...pending, next: payload } : {
          expected: revision, id: crypto.randomUUID(), payload
        });
      } catch {
        saveWarning("此瀏覽器空間不足，無法保存進度。");
        return false;
      }
      current = payload;
      void sync();
      return true;
    }
  };
  let importCheck;
  if (guest) {
    importCheck = new Promise(resolve => {
      window.fishDuelCloud.getGuestImport = () => guest?.payload ?? "";
      window.fishDuelCloud.finishGuestImport = async (valid, reply) => {
        const candidate = guest;
        if (!window.fishDuelCloud.finishGuestImport) return;
        delete window.fishDuelCloud.finishGuestImport;
        delete window.fishDuelCloud.getGuestImport;
        let imported = false;
        try {
          if (!valid) {
            message.textContent = "試玩存檔無法讀取，請重新載入並略過轉移。";
            return;
          }
          const { data: auth } = await client.auth.getSession();
          if (!active || auth.session?.user.id !== account) throw new Error("Account changed");
          const transfer = candidate.transfer ?? { account, id: crypto.randomUUID() };
          writeGuest({ ...candidate, transfer });
          // Revision zero is insert-only on the server, even if another
          // browser starts playing between the read and this request.
          const { data, error } = await client.rpc("write_fishduel_save_v2", {
            expected: 0, operation: transfer.id, contents: candidate.payload
          }).abortSignal(AbortSignal.timeout(15000));
          if (error) throw error;
          if (data !== 1) {
            writeGuest({ ...candidate, transfer: { ...transfer, closed: true } });
            message.textContent = "帳號已有雲端進度，試玩進度已留在此瀏覽器。請重新載入。";
            return;
          }
          revision = data;
          current = candidate.payload;
          imported = true;
          try { localStorage.removeItem(guestKey); }
          catch { /* Reconciled using the matching request ID on reload. */ }
        } catch {
          message.textContent = "暫時無法確認進度轉移。試玩存檔已保留，請重新載入。";
        } finally {
          guest = null;
          try { reply(imported); }
          finally { resolve(imported); }
        }
      };
    });
  }
  if (duelApi && !toolsMode) {
    const mobileSettlement = duelApi === "supabase";
    window.fishDuelFriends = {
      mobileSettlement,
      invitation: () => sessionStorage.getItem(inviteKey) || "",
      opened() {
        sessionStorage.removeItem(inviteKey);
        const url = new URL(location.href);
        url.searchParams.delete("duel");
        history.replaceState(null, "", url);
      },
      link(code) {
        const url = new URL("./", location.href);
        url.searchParams.set("duel", code);
        return url.href;
      },
      async sendRequest(action, body, reply) {
        let result;
        try {
          const actions = ["inspect","create","accept","recent","cancel","replay"];
          if (mobileSettlement) actions.push("finish");
          if (!actions.includes(action)) throw new Error();
          if (["create","accept"].includes(action)) {
            await sync();
            if (pending || sending || conflict) throw new Error("請等候雲端存檔同步後再試。");
          }
          const { data } = await client.auth.getSession();
          if (!active || data.session?.user.id !== account) throw new Error("請重新登入。");
          if (mobileSettlement) {
            const rpc = await client.rpc("fishduel_friend", { action_name: action, payload: JSON.parse(body) })
              .abortSignal(AbortSignal.timeout(20000));
            if (rpc.error || !rpc.data) throw new Error();
            result = rpc.data;
          } else {
            const res = await fetch(duelApi + "/" + action, {
              method: "POST", redirect: "error", cache: "no-store",
              headers: { Authorization: "Bearer " + data.session.access_token, "Content-Type": "application/json" },
              body, signal: AbortSignal.timeout(30000)
            });
            result = await res.json();
            if (!res.ok && !result.error) throw new Error();
          }
        } catch (error) {
          result = { error: ["請重新登入。", "請等候雲端存檔同步後再試。"].includes(error.message) ? error.message : "約戰服務暫時無法連線，請重試。" };
        }
        reply(JSON.stringify(result));
      }
    };
  }
  window.addEventListener("online", sync);
  window.addEventListener("beforeunload", (event) => {
    if (active && pending) event.preventDefault();
  });
  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || (session && session.user.id !== account)) {
      active = false;
      location.reload();
    }
  });
  setInterval(sync, 8000);
  void sync();
  if (conflict) {
    message.textContent = "請先處理尚未同步的進度。";
    return;
  }
  switchAccount.disabled = true;
  const pendingCast = "fishduel-care-cast:" + account;
  if (localStorage.getItem(pendingCast) && !toolsMode) {
    await new Promise(resolve => careRequest('{"action":"cast"}', result => {
      if (JSON.parse(result).error && localStorage.getItem(pendingCast)) {
        message.textContent = "上次釣魚等待同步，請重新載入。";
        retry.hidden = false;
      }
      resolve();
    }));
    if (localStorage.getItem(pendingCast)) return;
  }
  if (!toolsMode) {
    try {
      await settleAccount();
      const [values] = await Promise.all([
        careRpc("fishduel_care_affection", {}),
        careRpc("fishduel_care_shop", {}).then(state => { walletState = state; }).catch(() => {})
      ]);
      for (const [id, value] of Object.entries(values)) rememberFish(id, value);
    } catch { /* Care may be unavailable during rollout. Other game data remains playable. */ }
  }
  await startGame(importCheck);
}

async function startGame(importCheck) {
  message.textContent = "正在載入遊戲…";
  try {
    const canvas = element("canvas");
    canvas.hidden = false;
    const fitCanvas = () => {
      if (window.fishDuelVideo?.isRecording?.()) return;
      const area = canvas.parentElement.getBoundingClientRect();
      const width = Math.round(area.width * devicePixelRatio);
      const height = Math.round(area.height * devicePixelRatio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    canvas.addEventListener("fishduel-capture-ended", fitCanvas);
    fitCanvas();
    new ResizeObserver(fitCanvas).observe(canvas.parentElement);
    await new Engine({ ...window.fishDuelEngineConfig, canvas, canvasResizePolicy: 0 }).startGame();
    if (importCheck && !(await importCheck)) {
      canvas.hidden = true;
      switchAccount.disabled = false;
      retry.hidden = false;
      return false;
    }
    element("entry").hidden = true;
    canvas.focus();
    return true;
  } catch {
    element("canvas").hidden = true;
    switchAccount.disabled = false;
    message.textContent = "無法啟動遊戲，請重新載入。";
    retry.hidden = false;
    return false;
  }
}

boot().catch(() => {
  if (switchAccount.hidden) showGoogleLogin("暫時無法連接登入服務，仍可在此瀏覽器試玩。");
  else message.textContent = "無法讀取雲端存檔，請重新載入。";
  switchAccount.disabled = false;
  retry.hidden = false;
});
