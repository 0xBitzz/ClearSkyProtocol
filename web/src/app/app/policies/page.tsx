import { MyPoliciesCard } from "@/components/MyPoliciesCard";
import { PageHeader } from "@/components/PageHeader";

export default function PoliciesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Your cover"
        title="My policies"
        subtitle="Everything you've insured, and anything ready to claim."
      />
      <MyPoliciesCard />
    </>
  );
}
