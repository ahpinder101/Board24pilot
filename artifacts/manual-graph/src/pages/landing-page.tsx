import { useLocation } from "wouter";

export default function LandingPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-5 mb-8">
          <img
            src="/board24-logo.png"
            alt="Board24"
            className="h-20 w-auto object-contain rounded-xl"
          />
          <img
            src="/machinemesh-logo-black.svg"
            alt="Machine Mesh AI"
            className="h-14 w-auto object-contain"
          />
        </div>

        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-7">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-semibold text-slate-800 tracking-tight">
              Engineering Manual Knowledge Graph
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Sign in to explore your manuals
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setLocation("/sign-in")}
              className="w-full py-2.5 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm transition-all active:scale-[0.98]"
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setLocation("/sign-up")}
              className="w-full py-2.5 px-4 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold text-sm transition-all active:scale-[0.98]"
            >
              Create account
            </button>
          </div>
        </div>

        <p className="text-center text-slate-400 text-xs mt-6">
          &copy; {new Date().getFullYear()} Machine Mesh AI · Board24
        </p>
      </div>
    </div>
  );
}
