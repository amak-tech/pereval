import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/content/site";

export const metadata: Metadata = {
  title: "Ссылка отправлена",
  robots: { index: false, follow: false },
};

export default function LoginSentPage() {
  return (
    <div className="wrap max-w-[520px] py-12">
      <p className="eyebrow m-0 mb-2">Личный кабинет</p>
      <h1 className="m-0 text-[clamp(24px,5vw,32px)] font-semibold tracking-tight">Проверьте почту</h1>
      <div className="mt-6 rounded-xl border border-ok bg-ok-bg px-4 py-3 text-ok" role="status">
        Если аккаунт с этим email существует, мы отправили ссылку для входа. Проверьте почту и папку «Спам». Ссылка действует 15 минут и
        срабатывает один раз.
      </div>
      <p className="mt-6 text-mute">
        Письмо не пришло через пару минут? <Link href="/account/login">Запросить ещё раз</Link> (не чаще раза в минуту) или{" "}
        <a href={`mailto:${SITE.supportEmail ?? "support@pereval.top"}`}>напишите в поддержку</a>.
      </p>
    </div>
  );
}
