import qrcode from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

export type WaClient = InstanceType<typeof Client>;

export function createClient(): WaClient {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    takeoverOnConflict: false,
    puppeteer: {
      headless: true,
      channel: "chrome",
      args: ["--disable-gpu", "--no-first-run", "--disable-extensions"],
    },
  });
}

export function attachQr(client: WaClient): void {
  client.on("qr", (qr: string) => {
    qrcode.generate(qr, { small: true });
  });
}
