import React from 'react';
import { Menu, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface NavbarProps {
	title?: string;
	subtitle?: string;
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	showMenuButton?: boolean;
}

const Navbar: React.FC<NavbarProps> = ({
	title = 'PrintFlow3D',
	subtitle,
	onOpenSidebar,
	onOpenSettings,
	showMenuButton = true
}) => {
	const { t } = useTranslation();
	return (
		<header className="h-14 shrink-0 glass-strong border-b border-border-glow flex items-center px-3 gap-3">
			{showMenuButton && (
				<button
					type="button"
					onClick={onOpenSidebar}
					className="w-10 h-10 rounded-lg bg-vault-800 hover:bg-vault-700 border border-vault-700 flex items-center justify-center text-slate-200"
					aria-label={t('common.openSidebar')}
				>
					<Menu className="w-5 h-5" />
				</button>
			)}

			<div className="min-w-0 flex-1">
				<div className="text-sm font-semibold text-white truncate">{title}</div>
				{subtitle && <div className="text-xs text-slate-400 truncate">{subtitle}</div>}
			</div>

			<button
				type="button"
				onClick={onOpenSettings}
				className="w-10 h-10 rounded-lg bg-vault-800 hover:bg-vault-700 border border-vault-700 flex items-center justify-center text-slate-200"
				aria-label={t('common.openSettings')}
			>
				<SettingsIcon className="w-5 h-5" />
			</button>
		</header>
	);
};

export default Navbar;

