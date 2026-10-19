import { Radar } from 'lucide-react';
import type { AutomationHealth } from '@/lib/vct-types';
type Section = 'home' | 'predictions' | 'reviews' | 'matches';
const links: Array<{ key: Section; href: string; label: string }> = [
  { key: 'home', href: '/', label: '最新预测' },
  { key: 'predictions', href: '/predictions', label: '预测历史' },
  { key: 'reviews', href: '/reviews', label: '赛后复盘' },
  { key: 'matches', href: '/matches', label: '预测表现' },
];
export function SiteHeader({
  active,
  systemStatus,
}: {
  active: Section;
  aiConfigured?: boolean;
  systemStatus?: AutomationHealth['status'];
}) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="VCT 预测实验室首页">
        <span className="brand-mark">
          <Radar aria-hidden="true" />
        </span>
        <span>
          <strong>VCT Forecast Lab</strong>
          <small>赛前预测 · 赛后检验</small>
        </span>
      </a>
      <nav aria-label="主导航">
        {links.map((link) => (
          <a
            key={link.key}
            aria-current={active === link.key ? 'page' : undefined}
            className={active === link.key ? 'active' : undefined}
            href={link.href}
          >
            {link.label}
          </a>
        ))}
      </nav>
      <div className="system-state">
        {systemStatus && (
          <span>
            {systemStatus === 'healthy' ? '云端更新正常' : '查看数据更新状态'}
          </span>
        )}
      </div>
    </header>
  );
}
export function SiteFooter() {
  return (
    <footer className="footer">
      <span>VCT Forecast Lab · 独立研究项目，非 Riot Games 官方产品</span>
      <span>赛前保存判断，赛后用真实结果检验</span>
    </footer>
  );
}
