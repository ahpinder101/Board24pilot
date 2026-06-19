import { useEffect, useRef } from "react";
import {
  Switch,
  Route,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useGetGlobalStats,
  getGetGlobalStatsQueryKey,
} from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import ManualGraphPage from "@/pages/manual-graph-page";
import GlobalGraphPage from "@/pages/global-graph-page";
import AskPage from "@/pages/ask-page";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing-page";
import AccessDeniedPage from "@/pages/access-denied-page";

const queryClient = new QueryClient();

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev, auto-set in prod.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/machinemesh-logo-black.svg`,
  },
  variables: {
    colorPrimary: "#1e293b",
    colorForeground: "#1e293b",
    colorMutedForeground: "#94a3b8",
    colorDanger: "#dc2626",
    colorBackground: "#ffffff",
    colorInput: "#f8fafc",
    colorInputForeground: "#1e293b",
    colorNeutral: "#e2e8f0",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-lg border border-slate-200",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-slate-800",
    headerSubtitle: "text-slate-400",
    socialButtonsBlockButtonText: "text-slate-700",
    formFieldLabel: "text-slate-600",
    footerActionLink: "text-slate-800 font-semibold hover:text-slate-600",
    footerActionText: "text-slate-400",
    dividerText: "text-slate-400",
    identityPreviewEditButton: "text-slate-600",
    formFieldSuccessText: "text-green-600",
    alertText: "text-slate-700",
    logoBox: "h-12 mb-2",
    logoImage: "h-12 w-auto",
    socialButtonsBlockButton: "border-slate-200 hover:bg-slate-50",
    formButtonPrimary:
      "bg-slate-800 hover:bg-slate-700 text-white normal-case font-semibold",
    formFieldInput: "bg-slate-50 border-slate-200 text-slate-800",
    footerAction: "",
    dividerLine: "bg-slate-200",
    alert: "",
    otpCodeFieldInput: "text-slate-800",
    formFieldRow: "",
    main: "",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

function AppRoutes() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/manuals/:id" component={ManualGraphPage} />
        <Route path="/graph" component={GlobalGraphPage} />
        <Route path="/ask" component={AskPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Probes a lightweight authenticated endpoint to determine whether the
// signed-in user is on the server-side invite allowlist. A 403 means the
// account is authenticated but not authorized, so we show a friendly screen
// instead of a dashboard that silently fails to load.
function AccessGate() {
  const { error, isLoading } = useGetGlobalStats({
    query: {
      retry: false,
      staleTime: 60_000,
      queryKey: getGetGlobalStatsQueryKey(),
    },
  });

  if (error?.status === 403) {
    return <AccessDeniedPage />;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }

  return <AppRoutes />;
}

function ProtectedApp() {
  return (
    <>
      <Show when="signed-in">
        <AccessGate />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

// Keeps the cache fresh when the signed-in user changes.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access the knowledge graph",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Get started with Machine Mesh AI",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route component={ProtectedApp} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
