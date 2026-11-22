const element = (id) => document.getElementById(id);
const message = element("message");
const status = element("save-state");
const signIn = element("sign-in");
const switchAccount = element("switch-account");
const retry = element("retry");
const productionSite = "https://myfishking.vercel.app/";
const legacyOrigin = "https://z12312355-arch.github.io";
const inviteKey = "fishduel-friend-invite";
const inviteCode = new URL(location.href).searchParams.get("duel")?.toUpperCase();
const hasInvite = /^[0-9A-F]{10}$/.test(inviteCode || "");
retry.onclick = () => location.reload();
window.addEventListener("pageshow", event => {
  if (event.persisted) location.reload();
});

function saveWarning(text) {
  status.textContent = text;
  status.hidden = false;
}

function showGoogleLogin(client, prompt = "登入遊戲帳號") {
  message.textContent = prompt;
  signIn.hidden = false;
  signIn.onclick = async () => {
    signIn.disabled = true;
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: new URL("./", location.href).href, queryParams: { prompt: "select_account" } }
      });
      if (error) throw error;
    } catch {
      message.textContent = "無法開啟 Google 登入，請再試一次。";
      signIn.disabled = false;
    }
  };
}

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
  const config = await fetch("./cloud-config.json", { cache: "no-store" }).then(response => response.json());
  if (!config.url || !config.key) {
    message.textContent = "網頁版尚未連接登入服務。";
    return;
  }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.95.3/+esm");
  const client = createClient(config.url, config.key, {
    auth: { flowType: "pkce", storageKey: "fishduel-google-session", detectSessionInUrl: false }
  });
  if (code || callbackError) {
    const result = code && !callbackError ? await client.auth.exchangeCodeForSession(code) : null;
    if (!result?.data?.session || result.error) {
      showGoogleLogin(client, "登入連結已失效，請重新使用 Google 登入。");
      return;
    }
  }
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session) {
    showGoogleLogin(client);
    return;
  }
  const account = session.user.id;
  const { data: verified, error: claimsError } = await client.auth.getClaims(session.access_token);
  if (claimsError) throw claimsError;
  const claims = verified?.claims;
  const googleOAuth = claims?.sub === account
    && claims.app_metadata?.providers?.includes("google")
    && claims.amr?.some(entry => entry.method === "oauth");
  if (!googleOAuth) {
    const { error: signOutError } = await client.auth.signOut({ scope: "local" });
    if (signOutError) throw signOutError;
    showGoogleLogin(client, "請使用 Google 帳號登入遊戲。");
    return;
  }
  switchAccount.hidden = false;
  switchAccount.textContent = "切換帳號";
  switchAccount.onclick = async () => {
    switchAccount.disabled = true;
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      location.reload();
    } catch {
      message.textContent = "無法切換帳號，請稍後再試。";
      switchAccount.disabled = false;
    }
  };
  await navigator.locks.request("fishduel-play-" + account, { ifAvailable: true }, async lock => {
    if (!lock) {
      message.textContent = "這個帳號已在另一個分頁開啟。關閉該分頁後再重新載入。";
      retry.hidden = false;
      return;
    }
    let playbackAdmin = false;
    if (session.user.app_metadata?.fishduel_playback_admin === true) {
      const { data } = await client.auth.getUser();
      playbackAdmin = data?.user?.id === account && data.user.app_metadata?.fishduel_playback_admin === true;
    }
    await prepareGame(client, account, config.duelApi, playbackAdmin);
    // Keep the lock until this page is closed or reloaded.
    await new Promise(() => {});
  });
}

async function prepareGame(client, account, duelApi, playbackAdmin = false) {
  const { data: cloud, error } = await client.from("fishduel_save")
    .select("revision,request_id,payload").eq("player", account).maybeSingle();
  if (error) throw error;
  const storageKey = "fishduel-outbox:" + account;
  let revision = cloud?.revision ?? 0;
  let pending = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  let current = pending?.next ?? pending?.payload ?? cloud?.payload ?? "";
  let sending = false;
  let conflict = false;
  let active = true;

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
      const { data, error } = await client.rpc("write_fishduel_save", {
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
  window.fishDuelPlayer = { nickname, displayName: () => displayName, requestNickname };
  void requestNickname(null);

  window.fishDuelCloud = {
    playbackAdmin,
    getSave: () => current,
    requestSignOut,
    queueSave(payload) {
      if (conflict || !active || payload.length > 2097152) return false;
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
  if (duelApi) {
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
  message.textContent = "正在載入遊戲…";
  try {
    const canvas = element("canvas");
    canvas.hidden = false;
    const fitCanvas = () => {
      const area = canvas.parentElement.getBoundingClientRect();
      const width = Math.round(area.width * devicePixelRatio);
      const height = Math.round(area.height * devicePixelRatio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    fitCanvas();
    new ResizeObserver(fitCanvas).observe(canvas.parentElement);
    await new Engine({ ...window.fishDuelEngineConfig, canvas, canvasResizePolicy: 0 }).startGame();
    element("entry").hidden = true;
    canvas.focus();
  } catch {
    element("canvas").hidden = true;
    switchAccount.disabled = false;
    message.textContent = "無法啟動遊戲，請重新載入。";
    retry.hidden = false;
  }
}

boot().catch(() => {
  message.textContent = "無法讀取登入狀態或雲端存檔，請重新載入。";
  retry.hidden = false;
});
