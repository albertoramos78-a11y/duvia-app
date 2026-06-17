// ── Thèmes et palettes de couleurs Duvia ─────────────────────────────────────

export const DARK   = { bg:"#1c1c1c",card:"#272727",sur:"#313131",bor:"#484848",txt:"#ebebeb",mut:"#999999",inp:"#272727",vio:"#9090f8",blu:"#6aaaf5",grn:"#2dd4a8",yel:"#f5c842",red:"#ff6b6b",ora:"#ff9f43",pin:"#ff85c8" };
export const LIGHT  = { bg:"#f3f4f8",card:"#ffffff",sur:"#f0f1f6",bor:"#d1d5db",txt:"#111827",mut:"#6b7280",inp:"#ffffff",vio:"#6d5fc7",blu:"#2563eb",grn:"#059669",yel:"#d97706",red:"#dc2626",ora:"#ea580c",pin:"#db2777" };
export const SUMMER = { bg:"#fff8e7",card:"#fffdf5",sur:"#fff3cc",bor:"#fcd34d",txt:"#7c3d00",mut:"#b45309",inp:"#fffdf5",vio:"#f97316",blu:"#06b6d4",grn:"#10b981",yel:"#f59e0b",red:"#ef4444",ora:"#f97316",pin:"#ec4899",_summer:true };
export const RG = { bg:"#f5ede6",card:"#fff9f6",sur:"#eedfd6",bor:"#c2745a",txt:"#2d1a0e",mut:"#7a4a35",inp:"#fff9f6",vio:"#c2745a",blu:"#1a6b3c",grn:"#1a6b3c",yel:"#e8a84c",red:"#c0392b",ora:"#d45f2e",pin:"#c2745a",_rg:true };
export const RG_START = new Date("2026-05-24"); const RG_END = new Date("2026-06-04T23:59:59");
function isRGPeriod() { const n=new Date(); return n>=RG_START && n<=RG_END; }
export const WC = { bg:"#f0f7ff",card:"#ffffff",sur:"#e8f4ff",bor:"#3b82f6",txt:"#0f172a",mut:"#475569",inp:"#ffffff",vio:"#2563eb",blu:"#1d4ed8",grn:"#16a34a",yel:"#ca8a04",red:"#dc2626",ora:"#ea580c",pin:"#7c3aed",_wc:true };
export const WC_START = new Date("2026-06-06"); const WC_END = new Date("2026-07-26T23:59:59");
function isWCPeriod() { const n=new Date(); return n>=WC_START && n<=WC_END; }
export const SUMMER_START = new Date("2026-06-21"); const SUMMER_END = new Date("2026-07-23T23:59:59");
function isSummerPeriod() { const n=new Date(); return n>=SUMMER_START && n<=SUMMER_END; }
// ─── THÈME JEU VIDÉO ──────────────────────────────────────────────────────────
export const VIDEO = { bg:"#07071a",card:"#0f0f2a",sur:"#181835",bor:"#5b21b6",txt:"#ede9fe",mut:"#7c6fa0",inp:"#0b0b22",vio:"#8b5cf6",blu:"#06b6d4",grn:"#22c55e",yel:"#fbbf24",red:"#f43f5e",ora:"#fb923c",pin:"#ec4899",_video:true };
// ─── BRAND THEME — Thème principal (palette extraite du gradient bleu→rose) ──
export const BRAND = { bg:"#F2EDFF",card:"#FFFFFF",sur:"#EAE3FF",bor:"#C6B8EE",txt:"#17103A",mut:"#7269A8",inp:"#FFFFFF",vio:"#7B7CF5",blu:"#5B98F2",grn:"#2DD4A8",yel:"#F5B540",red:"#FF4692",ora:"#FF7B60",pin:"#FF6CB8",_brand:true };
export const PCOLS = ["#f97316","#06b6d4","#10b981","#f59e0b","#ec4899","#ef4444"];
