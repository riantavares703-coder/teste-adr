import { formatBRL } from '@plataforma/domain';

export interface ButtonProps {
  children: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export interface PriceProps {
  cents: number;
  className?: string;
}

export { formatBRL };
