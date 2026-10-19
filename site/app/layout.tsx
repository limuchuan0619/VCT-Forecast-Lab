import type { Metadata } from 'next';
import { IBM_Plex_Mono, Noto_Sans_SC } from 'next/font/google';
import './globals.css';

const sans = Noto_Sans_SC({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
});

const mono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'VCT Forecast Lab｜可解释比赛预测',
  description:
    '赛前看胜率与依据，赛后读地图与选手分析，用真实结果检验每一次判断。',
  openGraph: {
    title: 'VCT Forecast Lab',
    description: '赛前预测 · 赛后复盘',
    type: 'website',
    locale: 'zh_CN',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'VCT Forecast Lab｜可解释预测 · 受控进化',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'VCT Forecast Lab',
    description: '赛前预测 · 赛后复盘',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
