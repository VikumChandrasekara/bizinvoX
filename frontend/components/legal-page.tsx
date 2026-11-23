import Link from "next/link";

export type LegalSection = { heading: string; body: React.ReactNode };

/** Shared layout for the Privacy Policy and Terms pages. */
export function LegalPage({ title, updated, intro, sections }: { title: string; updated: string; intro: string; sections: LegalSection[] }) {
  return (
    <main className="px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
      <article className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          &larr; Back to the invoice editor
        </Link>
        <h1 className="mt-4 text-3xl font-bold sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
        <p className="mt-6 leading-relaxed text-muted-foreground">{intro}</p>

        <nav aria-label="On this page" className="mt-8 rounded-xl border bg-muted/30 p-4">
          <ol className="grid gap-1.5 text-sm sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.heading}>
                <a href={`#s${i + 1}`} className="text-muted-foreground transition hover:text-foreground">
                  {i + 1}. {s.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {sections.map((s, i) => (
            <section key={s.heading} id={`s${i + 1}`} className="scroll-mt-28">
              <h2 className="text-xl font-semibold">
                {i + 1}. {s.heading}
              </h2>
              <div className="mt-3 space-y-3 leading-relaxed text-muted-foreground [&_a]:font-medium [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground">{s.body}</div>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}
