import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../../hooks/useAuth';
import { ApiError } from '../../services/api';
import styles from './LoginPage.module.css';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
  displayName: z.string().min(1, 'Tell us your name').optional(),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { login, register: registerUser } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (mode === 'register') {
        const requiresVerification = await registerUser(
          values.email,
          values.password,
          values.displayName ?? '',
        );
        navigate(requiresVerification ? '/verify-email' : '/activity');
        return;
      }
      await login(values.email, values.password);
      navigate('/activity');
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.brand}>Stewra</h1>
        <p className={styles.tagline}>A careful advisor that only reads — and never acts without you.</p>

        <div className={styles.tabs}>
          <button
            type="button"
            className={mode === 'login' ? styles.tabActive : styles.tab}
            onClick={() => setMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'register' ? styles.tabActive : styles.tab}
            onClick={() => setMode('register')}
          >
            Create account
          </button>
        </div>

        <form onSubmit={onSubmit} className={styles.form}>
          {mode === 'register' && (
            <label className={styles.field}>
              <span>Name</span>
              <input type="text" autoComplete="name" {...register('displayName')} />
              {errors.displayName && <em className={styles.err}>{errors.displayName.message}</em>}
            </label>
          )}

          <label className={styles.field}>
            <span>Email</span>
            <input type="email" autoComplete="email" {...register('email')} />
            {errors.email && <em className={styles.err}>{errors.email.message}</em>}
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              {...register('password')}
            />
            {errors.password && <em className={styles.err}>{errors.password.message}</em>}
          </label>

          {serverError && <div className={styles.serverErr}>{serverError}</div>}

          <button type="submit" className={styles.submit} disabled={isSubmitting}>
            {isSubmitting ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
