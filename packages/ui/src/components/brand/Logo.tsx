import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import type { ComponentProps, SVGProps } from "react";

import { cn } from "@/lib/utils";

/** The approved product mark copied from the laser.hubtrix.com brand assets. */
export function LaserLogo({ className, ...props }: Omit<ComponentProps<"img">, "src" | "alt">) {
  return (
    <img
      src="/icons/laser-mark-192.png"
      alt={PRODUCT_DISPLAY_NAME}
      draggable={false}
      className={cn("block select-none", className)}
      {...props}
    />
  );
}

/** The website's transparent mark, adapted to the active theme for contrast. */
export function LaserMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="307 299 1451 1451"
      className={cn("block text-ink", className)}
      {...props}
    >
      <path fill="currentColor" d="M1180.79 306.057C1225.56 305.663 1256.36 305.598 1291.95 338.371C1315.37 359.95 1329.19 389.986 1330.35 421.805C1331.54 455.906 1330.8 493.514 1330.77 527.834L1330.74 701.761L1330.82 1217.7L1330.82 1498.43L1330.88 1583.44C1330.89 1635.65 1333.67 1666.04 1295.65 1707.16C1295.14 1707.69 1294.63 1708.21 1294.11 1708.72C1259.1 1743.11 1225.46 1742.17 1180.7 1742.15L1180.79 306.057Z" />
      <path fill="currentColor" d="M833.995 306.443C844.749 305.949 856.731 306.121 867.58 306.052L867.848 900.005L751.824 899.952L718.22 900.041C717.581 788.894 717.767 677.744 718.779 566.599L718.468 467.507C718.257 420.39 714.978 382.516 749.873 345.152C773.13 320.248 799.966 307.958 833.995 306.443Z" />
      <path fill="currentColor" d="M718.272 1150.4C764.876 1149.26 820.964 1150.1 867.992 1150.58L867.964 1549.21L867.966 1676.81C867.972 1695.62 869.012 1724.11 867.677 1742.13C860.719 1742.26 853.761 1742.34 846.802 1742.38C809.736 1742.56 779.768 1733.46 752.819 1707.25C714.574 1670.06 718.171 1627.35 718.256 1579.36L718.454 1476.54L718.272 1150.4Z" />
      <path fill="var(--live)" d="M499.374 946.498L1136.13 946.161L1136.21 1102.65L952.75 1102.77L566.611 1102.68L457.318 1102.75C411.994 1102.77 373.235 1108.36 337.618 1074.73C308.228 1046.97 306.689 1005.51 335.501 976.76C366.41 945.915 399.289 946.895 439.388 946.713L499.374 946.498Z" />
      <path fill="var(--live)" d="M1370.99 946.371L1555.05 946.608L1610.12 946.538C1627.3 946.521 1651.58 945.178 1667.76 949.988C1729.19 968.251 1757.85 1028.3 1709.11 1077.17C1695.59 1088.75 1679.29 1096.63 1661.82 1100.04C1641.13 1104.05 1585.29 1102.63 1560.71 1102.66L1371 1102.65L1370.99 946.371Z" />
    </svg>
  );
}
