import "./landing.css";
import { LandingMotion } from "./motion-pref";
import { LandingHeader } from "./landing-header";
import { LandingHero } from "./hero";
import { Problem } from "./problem";
import { Compare } from "./compare";
import { HowItWorks } from "./how-it-works";
import { Tour } from "./tour";
import { PrivacyTable } from "./privacy-table";
import { Integrations } from "./integrations";
import { Roadmap } from "./roadmap";
import { Faq } from "./faq";
import { FinalCta } from "./final-cta";

/** Marketing landing at "/". The app itself lives at /feed and below. */
export function Landing() {
  return (
    <LandingMotion>
      <LandingHeader />
      <LandingHero />
      <Problem />
      <Compare />
      <HowItWorks />
      <Tour />
      <PrivacyTable />
      <Integrations />
      <Roadmap />
      <Faq />
      <FinalCta />
    </LandingMotion>
  );
}
