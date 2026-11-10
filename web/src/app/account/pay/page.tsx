import type { Metadata } from "next";
import { Suspense } from "react";
import { PayStatus } from "@/components/account/PayStatus";

export const metadata: Metadata = {
  title: "Статус оплаты",
  robots: { index: false, follow: false },
};

export default function PayPage() {
  return (
    <div className="wrap max-w-[560px] py-12">
      <p className="eyebrow m-0 mb-2">Перевал Pro</p>
      <Suspense fallback={<p className="text-mute">Проверяем оплату…</p>}>
        <PayStatus />
      </Suspense>
    </div>
  );
}
