import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "unzeen",
    short_name: "unzeen",
    description: "Private trading for launchpads, paid in shielded ZEC. Launch anywhere. Stay unzeen.",
    start_url: "/feed",
    display: "standalone",
    background_color: "#0B0B0D",
    theme_color: "#060607",
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
