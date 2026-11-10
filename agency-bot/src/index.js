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
const mentions = db.collection("mentions");

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

/* ---------- إرسال تغذية واحدة (مع دعم إرفاق صورة أو PDF) ---------- */
async function sendOne(ref) {
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.get("notify.status") !== "pending") return null;
    tx.update(ref, { "notify.status": "sending", "notify.claimedAt": FieldValue.serverTimestamp() });
    return s.data();
  });
  if (!claimed) return;

  const text = String(claimed.message || "").trim();
  const attachment = claimed.attachment;

  if (!text && !attachment) {
    await ref.update({ "notify.status": "failed", "notify.error": "الرسالة فارغة ولا يوجد مرفق" });
    return;
  }

  try {
    await sleep(1000 + Math.random() * 2000); // تأخير بسيط يشبه الكتابة البشرية
    let res;

    if (attachment && attachment.data) {
      const raw = attachment.data.includes(",") ? attachment.data.split(",")[1] : attachment.data;
      const buf = Buffer.from(raw, "base64");
      const isImg = attachment.type === "image" || (attachment.mimetype && attachment.mimetype.startsWith("image/"));
      const isPdf = attachment.type === "pdf" || attachment.mimetype === "application/pdf" || (attachment.name && attachment.name.toLowerCase().endsWith(".pdf"));

      if (isImg) {
        res = await wa.sock().sendMessage(GROUP_JID, {
          image: buf,
          caption: text || undefined,
        });
      } else if (isPdf) {
        res = await wa.sock().sendMessage(GROUP_JID, {
          document: buf,
          mimetype: "application/pdf",
          fileName: attachment.name || "receipt.pdf",
          caption: text || undefined,
        });
      } else {
        res = await wa.sock().sendMessage(GROUP_JID, {
          document: buf,
          mimetype: attachment.mimetype || "application/octet-stream",
          fileName: attachment.name || "attachment",
          caption: text || undefined,
        });
      }
    } else {
      res = await wa.sock().sendMessage(GROUP_JID, { text });
    }

    await ref.update({
      "notify.status": "sent",
      "notify.sentAt": FieldValue.serverTimestamp(),
      "notify.waMessageId": res?.key?.id ?? null,
    });
    log("اترسلت:", text + (attachment ? ` (مع مرفق: ${attachment.name})` : ""));
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

/* لو البوت وقع وسط الإرسال، ما نعيد الإرسال تلقائياً */
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

/* ---------- رصد المنشن في رسائل الواتساب الواردة ---------- */
function registerMessageListener(sock) {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      // تجاهل الرسائل الصادرة من البوت نفسه
      if (m.key.fromMe) return;

      const remoteJid = m.key.remoteJid || "";
      // فحص الرسائل القادمة في الجروب أو في الخاص
      if (remoteJid !== GROUP_JID && !remoteJid.endsWith("@s.whatsapp.net")) continue;

      const msgContent = m.message;
      if (!msgContent) continue;

      const unwrapped = msgContent.ephemeralMessage?.message ||
                        msgContent.viewOnceMessage?.message ||
                        msgContent.viewOnceMessageV2?.message ||
                        msgContent.documentWithCaptionMessage?.message ||
                        msgContent;

      const text = (unwrapped.conversation ||
                    unwrapped.extendedTextMessage?.text ||
                    unwrapped.imageMessage?.caption ||
                    unwrapped.videoMessage?.caption ||
                    unwrapped.documentMessage?.caption || "").trim();

      const context = unwrapped.extendedTextMessage?.contextInfo ||
                      unwrapped.imageMessage?.contextInfo ||
                      unwrapped.videoMessage?.contextInfo ||
                      unwrapped.documentMessage?.contextInfo;

      const mentionedJids = context?.mentionedJid || [];
      const hasMention = mentionedJids.length > 0 || text.includes("@");

      if (hasMention) {
        const senderName = m.pushName || (m.key.participant || remoteJid).split("@")[0];
        const senderPhone = (m.key.participant || remoteJid).split("@")[0];

        try {
          await mentions.add({
            text,
            senderName,
            senderPhone,
            mentionedJids,
            groupJid: remoteJid,
            createdAt: FieldValue.serverTimestamp(),
            read: false,
          });
          log(`🔔 تم تسجيل منشن جديد من ${senderName}: ${text}`);
        } catch (e) {
          console.error("خطأ في تسجيل المنشن:", e.message);
        }
      }
    }
  });
}

/* ---------- تشغيل ---------- */
const wa = startWhatsApp({
  authDir: AUTH_DIR,
  pairingPhone: PAIRING_PHONE,
  onOpen: (sock) => {
    registerMessageListener(sock);
    beat();
    drain();
  },
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
