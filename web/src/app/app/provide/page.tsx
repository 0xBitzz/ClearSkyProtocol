import { PageHeader } from "@/components/PageHeader";
import { ProvideLiquidityCard } from "@/components/ProvideLiquidityCard";

export default function ProvidePage() {
  return (
    <>
      <PageHeader
        eyebrow="Underwriting"
        title="Provide liquidity"
        subtitle="Back the policies travellers buy. Keep the premiums on flights that land on time."
      />
      <ProvideLiquidityCard />
    </>
  );
}
