import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { startWhatsApp } from "./wa.js";

const { GROUP_JID, GOOGLE_APPLICATION_CREDENTIALS, PAIRING_PHONE, AUTH_DIR = "./auth" } = process.env;

if (!GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("ناقص GOOGLE_APPLICATION_CREDENTIALS في ملف .env (مسار ملف serviceAccount.json).");
  process.exit(1);
}
if (!GROUP_JID || !GROUP_JID.endsWith("@g.us")) {
  console.error("ناقص GROUP_JID في ملف .env. شغّل `npm run groups` عشان تجيبه (شكله 1203630xxxxxxxxx@g.us).");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const topups = db.collection("topups");

/* ---------- نبض البوت (الصفحة تعرض تنبيه لو انقطع) ---------- */
async function beat() {
  try {
    await db.doc("system/bot").set(
      { lastSeen: FieldValue.serverTimestamp(), whatsapp: wa.isOpen() ? "open" : "closed" },
      { merge: true },
    );
  } catch (e) {
    console.error("تعذر تحديث النبض:", e.message);
  }
}

/* ---------- إرسال تغذية واحدة ---------- */
async function sendOne(ref) {
  // نحجزها أولاً داخل transaction عشان ما تنرسل مرتين
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.get("notify.status") !== "pending") return null;
    tx.update(ref, { "notify.status": "sending", "notify.claimedAt": FieldValue.serverTimestamp() });
    return s.data();
  });
  if (!claimed) return;

  const text = String(claimed.message || "").trim();
  if (!text) {
    await ref.update({ "notify.status": "failed", "notify.error": "الرسالة فاضية" });
    return;
  }

  try {
    await sleep(1000 + Math.random() * 2000); // تأخير بسيط يشبه الكتابة البشرية
    const res = await wa.sock().sendMessage(GROUP_JID, { text });
    await ref.update({
      "notify.status": "sent",
      "notify.sentAt": FieldValue.serverTimestamp(),
      "notify.waMessageId": res?.key?.id ?? null,
    });
    log("اترسلت:", text);
  } catch (e) {
    const err = String(e?.message ?? e).slice(0, 200);
    log("فشل الإرسال:", err);
    await ref.update({ "notify.status": "failed", "notify.error": err });
  }
}

/* ---------- تصريف الطابور ---------- */
let draining = false;
let again = false;

async function drain() {
  if (!wa.isOpen()) return;
  if (draining) { again = true; return; }
  draining = true;
  try {
    do {
      again = false;
      const snap = await topups.where("notify.status", "==", "pending").get();
      const ms = (d) => d.get("createdAt")?.toMillis?.() ?? 0;
      const docs = snap.docs.sort((a, b) => ms(a) - ms(b)); // الأقدم أولاً
      for (const d of docs) {
        if (!wa.isOpen()) break;
        await sendOne(d.ref);
      }
    } while (again && wa.isOpen());
  } catch (e) {
    console.error("خطأ في تصريف الطابور:", e.message);
  } finally {
    draining = false;
  }
}

/* لو البوت وقع وسط الإرسال، ما نعيد الإرسال تلقائياً (ممكن الرسالة وصلت). نعلّمها فاشلة ويقرر الموظف. */
async function recoverStuck() {
  const snap = await topups.where("notify.status", "==", "sending").get();
  for (const d of snap.docs) {
    await d.ref.update({
      "notify.status": "failed",
      "notify.error": "انقطع أثناء الإرسال. تأكد من الجروب قبل إعادة المحاولة.",
    });
  }
  if (snap.size) log(`علّمت ${snap.size} رسالة عالقة كفاشلة`);
}

/* ---------- تشغيل ---------- */
const wa = startWhatsApp({
  authDir: AUTH_DIR,
  pairingPhone: PAIRING_PHONE,
  onOpen: () => { beat(); drain(); },
  onClose: () => { beat(); },
});

await recoverStuck();

topups.where("notify.status", "==", "pending").onSnapshot(
  () => drain(),
  (e) => console.error("خطأ في الاستماع:", e.message),
);

await beat();
setInterval(beat, 60 * 1000);
setInterval(drain, 5 * 60 * 1000); // شبكة أمان

async function shutdown() {
  try {
    await db.doc("system/bot").set({ whatsapp: "closed" }, { merge: true });
  } catch { /* تجاهل */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

log("البوت شغال، بانتظار التغذيات…");
