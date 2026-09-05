/* oxlint-disable next/no-html-link-for-pages -- Full-page navigation is intentional for embedded-browser reliability. */
import { Radar } from 'lucide-react';
import type { AutomationHealth } from '@/lib/vct-types';

type Section = 'home' | 'predictions' | 'reviews' | 'matches';

const links: Array<{ key: Section; href: string; label: string }> = [
  { key: 'home', href: '/', label: '最新预测' },
  { key: 'predictions', href: '/predictions', label: '预测历史' },
  { key: 'reviews', href: '/reviews', label: '赛后复盘' },
  { key: 'matches', href: '/matches', label: '四赛区预测' },
];

export function SiteHeader({ active, aiConfigured = true, systemStatus }: { active: Section; aiConfigured?: boolean; systemStatus?: AutomationHealth['status'] }) {
  const statusLabel = systemStatus === 'healthy' ? '云端自动化正常'
    : systemStatus === 'stale' ? '数据同步已延迟'
      : systemStatus === 'degraded' ? '自动化部分异常'
        : systemStatus === 'waiting' ? '等待首次云端运行'
          : '云端预测系统';
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="VCT 预测实验室首页">
        <span className="brand-mark"><Radar aria-hidden="true" /></span>
        <span><strong>VCT Forecast Lab</strong><small>可解释预测与受控进化</small></span>
      </a>
      <nav aria-label="主导航">
        {links.map((link) => <a key={link.key} className={active === link.key ? 'active' : undefined} href={link.href}>{link.label}</a>)}
      </nav>
      <div className="system-state">
        <span className={`pulse ${systemStatus ?? ''}`} aria-hidden="true" />
        <span><strong>{statusLabel}</strong><small>{aiConfigured ? 'DeepSeek 影子层已配置' : 'DeepSeek 等待密钥'}</small></span>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <span>VCT Forecast Lab · 独立研究项目，非 Riot Games 官方产品</span>
      <nav aria-label="页脚导航"><a href="/predictions">预测历史</a><a href="/reviews">赛后复盘</a><a href="/matches">四赛区预测</a></nav>
    </footer>
  );
}
