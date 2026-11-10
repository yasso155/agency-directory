import { startWhatsApp } from "./wa.js";

const { PAIRING_PHONE, AUTH_DIR = "./auth" } = process.env;

startWhatsApp({
  authDir: AUTH_DIR,
  pairingPhone: PAIRING_PHONE,
  onOpen: async (sock) => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups);
      console.log(`\nالجروبات اللي الرقم عضو فيها (${list.length}):\n`);
      for (const g of list) {
        console.log(`${g.id}\t${g.subject}\t(${g.participants.length} عضو)`);
      }
      console.log("\nانسخ الـ ID (اللي ينتهي بـ @g.us) للجروب المطلوب وحطه في GROUP_JID داخل .env\n");
    } catch (e) {
      console.error("تعذر جلب الجروبات:", e?.message ?? e);
    }
    process.exit(0);
  },
});
