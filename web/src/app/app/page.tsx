import { BuyPolicyCard } from "@/components/BuyPolicyCard";
import { PageHeader } from "@/components/PageHeader";

export default function InsurePage() {
  return (
    <>
      <PageHeader
        eyebrow="New policy"
        title="Insure a flight"
        subtitle="Pay a premium now, get a fixed multiple back if the flight runs late."
        aside={
          <span className="chip-active">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />
            Agent monitoring
          </span>
        }
      />
      <BuyPolicyCard />
    </>
  );
}
