import { HeroSection } from "@/components/landing/HeroSection";
import { TrendingStyles } from "@/components/landing/TrendingStyles";
import { connection } from "next/server";

export default async function HomePage() {
  await connection();
  return <main className="landing-page"><HeroSection /><TrendingStyles /></main>;
}
