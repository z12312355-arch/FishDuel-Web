const encoder = new TextEncoder();
async function macKey(secret) {
  if (!secret || secret.length < 43) throw Error("Missing settlement secret");
  return crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
}
export async function sign(secret, direction, body) {
  const bytes = await crypto.subtle.sign("HMAC",await macKey(secret),encoder.encode(direction+"\n"+body));
  return Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,"0")).join("");
}
export async function verify(secret, direction, body, signature) {
  if (!/^[0-9a-f]{64}$/.test(signature || "")) return false;
  return crypto.subtle.verify("HMAC",await macKey(secret),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),encoder.encode(direction+"\n"+body));
}
