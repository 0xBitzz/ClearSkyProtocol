import { notFound } from "next/navigation";
import { FaucetCard } from "@/components/FaucetCard";
import { PageHeader } from "@/components/PageHeader";
import { ASSET_IS_MINTABLE, ASSET_SYMBOL } from "@/lib/contracts";

export default function FaucetPage() {
  // The sidebar hides this link when the asset is real USDC, but the route
  // would still be reachable by URL, so refuse it here too.
  if (!ASSET_IS_MINTABLE) notFound();

  return (
    <>
      <PageHeader
        eyebrow="Testnet only"
        title={`Get test ${ASSET_SYMBOL}`}
        subtitle="Mint yourself some mock USDC to pay premiums and supply liquidity with."
      />
      <FaucetCard />
    </>
  );
}
