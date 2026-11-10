import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * يفتح اتصال واتساب ويعيد الاتصال تلقائياً عند الانقطاع.
 * onOpen(sock) يُنادى كل مرة يتصل فيها. onClose({code, loggedOut}) عند الانقطاع.
 */
export function startWhatsApp({ authDir, pairingPhone, onOpen, onClose }) {
  const logger = pino({ level: "silent" });
  const st = { sock: null, open: false, attempts: 0, pairingRequested: false };

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* نستخدم الإصدار الافتراضي للمكتبة */
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    st.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    // الربط بكود بدل QR (مناسب للسيرفرات)
    if (pairingPhone && !sock.authState.creds.registered && !st.pairingRequested) {
      st.pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(String(pairingPhone).replace(/\D/g, ""));
          console.log(`\nكود الربط: ${code}`);
          console.log("على رقم البوت: واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف بدلاً من ذلك، واكتب الكود.\n");
        } catch (e) {
          st.pairingRequested = false;
          console.error("تعذر طلب كود الربط:", e?.message ?? e);
        }
      }, 3000);
    }

    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr && !pairingPhone) {
        console.log("\nامسح الـ QR من رقم البوت: واتساب ← الأجهزة المرتبطة ← ربط جهاز\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        st.open = true;
        st.attempts = 0;
        log("واتساب متصل");
        onOpen?.(sock);
      }

      if (connection === "close") {
        st.open = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        log("واتساب انقطع", code ?? "");
        onClose?.({ code, loggedOut });
        if (loggedOut) {
          console.error("الجهاز اتسجّل خروجه من واتساب. احذف مجلد auth وشغّل الربط من جديد.");
          process.exit(1);
        }
        const wait = Math.min(30000, 3000 * 2 ** st.attempts++);
        setTimeout(() => connect().catch((e) => console.error("فشل إعادة الاتصال:", e)), wait);
      }
    });
  }

  connect().catch((e) => {
    console.error("فشل بدء الاتصال:", e);
    process.exit(1);
  });

  return { isOpen: () => st.open, sock: () => st.sock };
}
