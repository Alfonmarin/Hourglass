import type { Metadata } from 'next';
import { AnalyticsMount } from '@/analytics/AnalyticsMount';

export const metadata: Metadata = {
  title: 'Analytics',
  description:
    'On-chain, verifiable metrics for HourGlass — charge and claim counts, token volume, and breakdowns read straight from the HourGlass enforcer instances, no backend.',
};

export default function AnalyticsPage() {
  return <AnalyticsMount />;
}
