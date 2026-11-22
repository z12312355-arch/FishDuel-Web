const element = (id) => document.getElementById(id);
const message = element("message");
const status = element("save-state");
const signIn = element("sign-in");
const form = element("account-form");
const mode = element("auth-mode");
const submit = element("email-submit");
const passwordField = element("password");
const switchAccount = element("switch-account");
const retry = element("retry");
const forgot = element("forgot");
const recoveryKey = "fishduel-reset-player";
const inviteKey = "fishduel-friend-invite";
const inviteCode = new URL(location.href).searchParams.get("duel")?.toUpperCase();
if (/^[0-9A-F]{10}$/.test(inviteCode || "")) sessionStorage.setItem(inviteKey, inviteCode);
retry.onclick = () => location.reload();
window.addEventListener("pageshow", event => {
  if (event.persisted) location.reload();
});

function saveWarning(text) {
  status.textContent = text;
  status.hidden = false;
}

async function chooseAccount(client) {
  forgot.disabled = submit.disabled = mode.disabled = signIn.disabled = switchAccount.disabled = true;
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: new URL("./", location.href).href, queryParams: { prompt: "select_account" } }
    });
    if (error) throw error;
  } catch {
    message.textContent = "無法開啟 Google 登入，請再試一次。";
    forgot.disabled = submit.disabled = mode.disabled = signIn.disabled = switchAccount.disabled = false;
  }
}

function showAccountForm(client) {
  let registering = false;
  let requestingReset = false;
  function renderMode() {
    message.textContent = registering ? "建立遊戲帳號" : "登入遊戲帳號";
    submit.textContent = registering ? "註冊並開始遊戲" : "登入";
    mode.textContent = registering ? "已有帳號？登入" : "註冊新帳號";
    passwordField.autocomplete = registering ? "new-password" : "current-password";
    forgot.hidden = registering || requestingReset;
    passwordField.disabled = passwordField.hidden = element("password-label").hidden = requestingReset;
    signIn.hidden = requestingReset;
    if (requestingReset) {
      message.textContent = "輸入遊戲帳號的 Email";
      submit.textContent = "寄送重設連結";
      mode.textContent = "返回登入";
    }
  }
  renderMode();
  form.hidden = mode.hidden = signIn.hidden = false;
  mode.onclick = () => {
    registering = !requestingReset && !registering;
    requestingReset = false;
    passwordField.value = "";
    renderMode();
  };
  forgot.onclick = () => {
    requestingReset = true;
    passwordField.value = "";
    renderMode();
    element("email").focus();
  };
  signIn.onclick = () => chooseAccount(client);
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    forgot.disabled = submit.disabled = mode.disabled = signIn.disabled = true;
    const credentials = { email: element("email").value.trim(), password: passwordField.value };
    try {
      if (requestingReset) {
        const { error } = await client.auth.resetPasswordForEmail(credentials.email, {
          redirectTo: new URL("./", location.href).href
        });
        if (error) throw error;
        message.textContent = "若此信箱已註冊，請用同一個瀏覽器開啟信中的重設連結。";
        return;
      }
      const { data, error } = registering
        ? await client.auth.signUp(credentials)
        : await client.auth.signInWithPassword(credentials);
      if (error) throw error;
      passwordField.value = "";
      if (data.session) {
        location.reload();
        return;
      }
      registering = false;
      renderMode();
      message.textContent = "尚未登入遊戲，請使用 Email 和密碼登入。";
    } catch (error) {
      const notices = {
        invalid_credentials: "Email 或密碼有誤，請再試一次。",
        user_already_exists: "這個 Email 已經有帳號，請切換到登入。",
        email_not_confirmed: "請先到信箱完成 Email 驗證，再登入。",
        weak_password: "密碼強度不足，請使用較長的密碼並混合英數與符號。",
        over_email_send_rate_limit: "寄信次數過多，請稍後再試。",
        email_provider_disabled: "目前尚未開放 Email 帳號。",
        signup_disabled: "目前暫停新帳號註冊。"
      };
      message.textContent = notices[error.code] || (requestingReset ? "暫時無法寄送重設信，請稍後再試。" : registering ? "註冊失敗，請確認 Email 後再試一次。" : "登入失敗，請稍後再試。");
    } finally {
      forgot.disabled = submit.disabled = mode.disabled = signIn.disabled = false;
    }
  };
}

function showNewPassword(client, account) {
  element("email").disabled = element("email").hidden = true;
  form.querySelector('label[for="email"]').hidden = true;
  element("password-label").textContent = "新密碼";
  passwordField.autocomplete = "new-password";
  message.textContent = "為 " + account.email + " 設定新密碼";
  submit.textContent = "儲存新密碼";
  form.hidden = false;
  passwordField.focus();
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const { data, error: sessionError } = await client.auth.getUser();
      if (sessionError || data.user?.id !== account.id) {
        message.textContent = "登入狀態已變更，請重新開啟遊戲並申請連結。";
        retry.hidden = false;
        return;
      }
      const { error } = await client.auth.updateUser({ password: passwordField.value });
      if (error) throw error;
      passwordField.value = "";
      sessionStorage.removeItem(recoveryKey);
      location.reload();
    } catch (error) {
      message.textContent = error.code === "same_password" ? "請使用與原密碼不同的新密碼。" :
        error.code === "weak_password" ? "新密碼強度不足，請增加長度或混合英數與符號。" : "密碼更新失敗，請再試一次。";
    } finally {
      submit.disabled = false;
    }
  };
}

async function boot() {
  const config = await fetch("./cloud-config.json", { cache: "no-store" }).then(response => response.json());
  if (!config.url || !config.key) {
    message.textContent = "網頁版尚未連接登入服務。";
    return;
  }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.95.3/+esm");
  const callback = new URL(location.href);
  const code = callback.searchParams.get("code");
  const callbackError = callback.searchParams.has("error") || new URLSearchParams(callback.hash.slice(1)).has("error");
  const client = createClient(config.url, config.key, {
    auth: { flowType: "pkce", storageKey: "fishduel-google-session", detectSessionInUrl: false }
  });
  if (code || callbackError) {
    history.replaceState(null, "", callback.pathname);
    const result = code && !callbackError ? await client.auth.exchangeCodeForSession(code) : null;
    if (!result?.data?.session || result.error) {
      showAccountForm(client);
      message.textContent = "連結已失效或無法在此瀏覽器使用。請重新登入，或再申請重設密碼。";
      return;
    }
    if (result.data.redirectType === "PASSWORD_RECOVERY") {
      sessionStorage.setItem(recoveryKey, result.data.session.user.id);
    } else {
      sessionStorage.removeItem(recoveryKey);
    }
  }
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session) {
    showAccountForm(client);
    return;
  }
  const account = session.user.id;
  if (sessionStorage.getItem(recoveryKey) === account) {
    showNewPassword(client, session.user);
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
    await prepareGame(client, account, config.duelApi);
    // Keep the lock until this page is closed or reloaded.
    await new Promise(() => {});
  });
}

async function prepareGame(client, account, duelApi) {
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
