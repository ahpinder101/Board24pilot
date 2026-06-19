import { useClerk, useUser } from "@clerk/react";
import { ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function AccessDeniedPage() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
      <div className="w-[440px] max-w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-lg">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
          <ShieldX className="h-7 w-7 text-red-600" />
        </div>
        <h1 className="text-xl font-semibold text-slate-800">
          Access not authorized
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-500">
          {email ? (
            <>
              The account <span className="font-medium text-slate-700">{email}</span>{" "}
              isn&apos;t on the invite list for this app.
            </>
          ) : (
            <>Your account isn&apos;t on the invite list for this app.</>
          )}{" "}
          Please contact your administrator to request access.
        </p>
        <Button
          variant="outline"
          className="mt-6 w-full border-slate-200"
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
