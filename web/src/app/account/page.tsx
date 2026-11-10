import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { AccountDashboard } from "@/components/account/AccountDashboard";

export const metadata: Metadata = {
  title: "Личный кабинет",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/account/login");
  return (
    <div className="wrap py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow m-0 mb-1">Личный кабинет</p>
          <h1 className="m-0 text-[clamp(24px,5vw,32px)] font-semibold tracking-tight">Перевал Pro</h1>
          <p className="m-0 mt-1 text-sm text-mute">
            {session.user.email}
            {isAdminEmail(session.user.email) ? (
              <>
                {" · "}
                <Link href="/admin">админ-панель</Link>
              </>
            ) : null}
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" className="btn-secondary !px-3 !py-1.5 !text-sm">
            Выйти
          </button>
        </form>
      </div>
      <AccountDashboard />
    </div>
  );
}
