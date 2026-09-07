import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="text-fd-muted-foreground">This address holds no documentation page.</p>
      <Link
        to="/docs/$"
        params={{ _splat: "" }}
        className="text-fd-primary underline underline-offset-4"
      >
        Read the introduction
      </Link>
    </main>
  );
}
