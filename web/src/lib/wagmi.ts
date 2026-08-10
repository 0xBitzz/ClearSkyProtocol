import { http, createConfig, createStorage, cookieStorage, injected } from "wagmi";
import { defineChain } from "viem";


/**
 * Arc Testnet.
 *
 * Defined locally rather than imported from `viem/chains` so the RPC can be
 * overridden per-environment, and so the app is not pinned to a particular
 * viem release shipping the chain.
 *
 * Note the native currency: on Arc, gas is paid in USDC, not ETH.
 */
export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  // Server-rendered pages need cookie-backed storage, otherwise the connection
  // state flashes as disconnected on first paint.
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [arcTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
