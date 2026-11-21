const element = (id) => document.getElementById(id);
const message = element("message");
const status = element("save-state");
const signIn = element("sign-in");
const switchAccount = element("switch-account");
const start = element("start");
const retry = element("retry");
retry.onclick = () => location.reload();
window.addEventListener("pageshow", event => {
  if (event.persisted) location.reload();
});

function saveWarning(text) {
  status.textContent = text;
  status.hidden = false;
}

async function chooseAccount(client) {
  signIn.disabled = switchAccount.disabled = start.disabled = true;
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: new URL("./", location.href).href, queryParams: { prompt: "select_account" } }
    });
    if (error) throw error;
  } catch {
    message.textContent = "無法開啟 Google 登入，請再試一次。";
    signIn.disabled = switchAccount.disabled = start.disabled = false;
  }
}

async function boot() {
  const config = await fetch("./cloud-config.json", { cache: "no-store" }).then(response => response.json());
  if (!config.url || !config.key) {
    message.textContent = "網頁版尚未連接登入服務。";
    return;
  }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.95.3/+esm");
  const client = createClient(config.url, config.key, {
    auth: { flowType: "pkce", storageKey: "fishduel-google-session" }
  });
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session) {
    message.textContent = "首次登入會建立遊戲帳號，進度隨帳號保存。";
    signIn.hidden = false;
    signIn.onclick = () => chooseAccount(client);
    return;
  }
  const account = session.user.id;
  switchAccount.hidden = false;
  switchAccount.onclick = () => chooseAccount(client);
  await navigator.locks.request("fishduel-play-" + account, { ifAvailable: true }, async lock => {
    if (!lock) {
      message.textContent = "這個帳號已在另一個分頁開啟。關閉該分頁後再重新載入。";
      retry.hidden = false;
      return;
    }
    await prepareGame(client, account, session.user.email);
    // Keep the lock until this page is closed or reloaded.
    await new Promise(() => {});
  });
}

async function prepareGame(client, account, email) {
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

  window.fishDuelCloud = {
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
  start.hidden = false;
  message.textContent = email || "已登入 Google 帳號";
  start.onclick = async () => {
    start.disabled = switchAccount.disabled = true;
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
  };
}

boot().catch(() => {
  message.textContent = "無法讀取登入狀態或雲端存檔，請重新載入。";
  retry.hidden = false;
});
