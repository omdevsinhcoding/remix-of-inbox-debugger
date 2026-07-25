import { useEffect } from "react";
import { Link } from "react-router";
import { useRouteHead } from "@/lib/useRouteHead";

const CANONICAL_PATH = "/guides/netflix-tv-activation";

const NetflixTvActivationGuide = () => {
  useRouteHead({
    title: "netflix.com/tv2 Activation Code: Sign In on Any TV",
    description: "Activate Netflix on your smart TV, Roku, Fire TV, or Apple TV with netflix.com/tv2. Find your TV code in email and finish sign-in in under a minute.",
    ogTitle: "netflix.com/tv2 Activation Guide",
    ogDescription: "Use netflix.com/tv2 to enter your TV activation code and finish Netflix sign-in on smart TVs and streaming devices.",
  });

  useEffect(() => {
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    const prev = canonical.href;
    canonical.href = CANONICAL_PATH;

    const ldId = "ld-netflix-tv-activation-guide";
    let ld = document.getElementById(ldId) as HTMLScriptElement | null;
    if (!ld) {
      ld = document.createElement("script");
      ld.type = "application/ld+json";
      ld.id = ldId;
      document.head.appendChild(ld);
    }
    ld.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "How to activate Netflix using netflix.com/tv2",
      description:
        "Sign in to Netflix on a smart TV, streaming stick, or console by entering the TV activation code shown on your screen at netflix.com/tv2.",
      step: [
        { "@type": "HowToStep", name: "Open Netflix on your TV", text: "Launch the Netflix app on your smart TV or streaming device and choose 'Sign In'." },
        { "@type": "HowToStep", name: "Note the TV activation code", text: "Netflix shows a short activation code and asks you to visit netflix.com/tv2 on another device." },
        { "@type": "HowToStep", name: "Visit netflix.com/tv2", text: "On a phone or laptop, open netflix.com/tv2, sign in to your Netflix account, and enter the code from your TV." },
        { "@type": "HowToStep", name: "Confirm sign-in from email", text: "If Netflix emails a verification link or one-time code, open your inbox (Netflix Mail if you use a shared account), tap 'Yes, this was me', and return to your TV." },
      ],
    });

    return () => {
      canonical!.href = prev;
      document.getElementById(ldId)?.remove();
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <article className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
        <nav aria-label="Breadcrumb" className="text-xs text-slate-400 mb-6">
          <Link to="/" className="hover:text-white">Netflix Mail</Link>
          <span className="mx-2">/</span>
          <span>Guides</span>
          <span className="mx-2">/</span>
          <span className="text-slate-300">netflix.com/tv2 activation</span>
        </nav>

        <header className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            netflix.com/tv2 activation: sign in on any TV
          </h1>
          <p className="mt-4 text-slate-300 leading-relaxed">
            Trying to finish Netflix sign-in on a smart TV, Roku, Fire TV, Apple TV, or a game
            console? This guide walks through the <code className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-100">netflix.com/tv2</code> flow,
            where to find the TV activation code in your email, and how to finish in under a minute.
          </p>
        </header>

        <section className="space-y-4 mb-10">
          <h2 className="text-xl font-semibold">What is netflix.com/tv2?</h2>
          <p className="text-slate-300 leading-relaxed">
            <strong>netflix.com/tv2</strong> is the short URL Netflix shows on your TV when you
            sign in from a smart TV or streaming device. Instead of typing your email and password
            with a remote, Netflix generates a short TV code and asks you to enter it on a phone
            or laptop at <em>netflix.com/tv2</em>. Once you enter the code and confirm the
            account, playback starts on your TV.
          </p>
        </section>

        <section className="space-y-4 mb-10">
          <h2 className="text-xl font-semibold">Step-by-step: activate Netflix with a TV code</h2>
          <ol className="list-decimal pl-6 space-y-3 text-slate-300 leading-relaxed">
            <li>
              <strong>Open Netflix on your TV</strong> and pick <em>Sign In</em>. Netflix shows a
              short activation code (usually 4–6 characters) and asks you to visit
              <em> netflix.com/tv2</em> on another device.
            </li>
            <li>
              <strong>Open netflix.com/tv2</strong> on your phone or laptop and sign in with the
              Netflix account you want to link.
            </li>
            <li>
              <strong>Enter the TV activation code</strong> exactly as it appears on your TV, then
              press <em>Continue</em>.
            </li>
            <li>
              <strong>Check email if prompted.</strong> For shared or Extra Member accounts,
              Netflix may email a verification link or a one-time code. Open your inbox — or
              Netflix Mail if the account uses shared inbox access — tap <em>Yes, this was me</em>,
              and jump back to your TV. Playback resumes automatically.
            </li>
          </ol>
        </section>

        <section className="space-y-4 mb-10">
          <h2 className="text-xl font-semibold">Where is the Netflix TV code in email?</h2>
          <p className="text-slate-300 leading-relaxed">
            For shared Netflix accounts, the TV activation code and household verification code
            are delivered as email from <code className="px-1.5 py-0.5 rounded bg-slate-800">info@account.netflix.com</code>.
            Open <Link to="/" className="text-sky-400 hover:underline">Netflix Mail</Link>,
            pick your profile, and the latest sign-in email surfaces at the top of your inbox.
            Copy the 4-digit code (or tap the verification link) within 15 minutes.
          </p>
        </section>

        <section className="space-y-4 mb-10">
          <h2 className="text-xl font-semibold">Common problems and quick fixes</h2>
          <ul className="list-disc pl-6 space-y-3 text-slate-300 leading-relaxed">
            <li><strong>Code doesn't work:</strong> the TV code expires in about 10 minutes. On your TV, choose <em>Get new code</em> and enter the fresh one at netflix.com/tv2.</li>
            <li><strong>"Device not part of household":</strong> Netflix wants a household verification OTP. See our <Link to="/guides/netflix-household-verification" className="text-sky-400 hover:underline">household verification guide</Link>.</li>
            <li><strong>Wrong account:</strong> sign out at netflix.com and sign back in with the account tied to your TV.</li>
            <li><strong>TV can't reach Netflix:</strong> reboot the streaming device, then try activation again.</li>
          </ul>
        </section>

        <section className="space-y-4 mb-10" aria-labelledby="faq-heading">
          <h2 id="faq-heading" className="text-xl font-semibold">FAQ</h2>
          <div className="space-y-4">
            <details className="rounded-lg bg-slate-900/60 border border-slate-800 p-4">
              <summary className="font-semibold cursor-pointer">Is netflix.com/tv2 the same as netflix.com/tv8?</summary>
              <p className="mt-2 text-slate-300 leading-relaxed">
                Yes — Netflix rotates short activation URLs like <em>netflix.com/tv2</em>, <em>tv8</em>, and <em>activate</em>. Use whichever URL your TV displays; all of them accept a valid TV activation code.
              </p>
            </details>
            <details className="rounded-lg bg-slate-900/60 border border-slate-800 p-4">
              <summary className="font-semibold cursor-pointer">Does the TV activation code cost anything?</summary>
              <p className="mt-2 text-slate-300 leading-relaxed">Netflix never charges for the TV activation code itself — it only signs your existing subscription in on a new device.</p>
            </details>
            <details className="rounded-lg bg-slate-900/60 border border-slate-800 p-4">
              <summary className="font-semibold cursor-pointer">How long does a TV stay signed in after activation?</summary>
              <p className="mt-2 text-slate-300 leading-relaxed">Netflix keeps the TV signed in until you sign out, change the password, or Netflix requires a fresh household verification (typically every 31 days on a new network).</p>
            </details>
          </div>
        </section>

        <footer className="mt-12 pt-6 border-t border-slate-800 text-sm text-slate-400">
          <Link to="/" className="text-sky-400 hover:underline">← Back to Netflix Mail</Link>
        </footer>
      </article>
    </main>
  );
};

export default NetflixTvActivationGuide;
