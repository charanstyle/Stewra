# Forms and Validation

Complete guide to building forms with validation using Yup in React Native.

---

## Table of Contents

- [Basic Form](#basic-form)
- [Yup Validation](#yup-validation)
- [Form Hooks](#form-hooks)
- [Common Patterns](#common-patterns)

---

## Basic Form

### Simple Login Form

```typescript
import { useState } from 'react';
import { View, TextInput, Button, Text, StyleSheet } from 'react-native';

interface LoginForm {
  email: string;
  password: string;
}

export const LoginScreen: React.FC = () => {
  const [formData, setFormData] = useState<LoginForm>({
    email: '',
    password: '',
  });

  const handleSubmit = () => {
    console.log('Form submitted:', formData);
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Email"
        value={formData.email}
        onChangeText={(text) => setFormData({ ...formData, email: text })}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <TextInput
        style={styles.input}
        placeholder="Password"
        value={formData.password}
        onChangeText={(text) => setFormData({ ...formData, password: text })}
        secureTextEntry
      />

      <Button title="Login" onPress={handleSubmit} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    fontSize: 16,
  },
});
```

---

## Yup Validation

### Basic Schema

```typescript
import * as Yup from 'yup';

const loginSchema = Yup.object().shape({
  email: Yup.string()
    .email('Invalid email')
    .required('Email is required'),
  password: Yup.string()
    .min(8, 'Password must be at least 8 characters')
    .required('Password is required'),
});
```

### Form with Validation

```typescript
import { useState } from 'react';
import { View, TextInput, Button, Text, StyleSheet } from 'react-native';
import * as Yup from 'yup';

const loginSchema = Yup.object().shape({
  email: Yup.string().email('Invalid email').required('Email is required'),
  password: Yup.string().min(8, 'Password must be at least 8 characters').required('Password is required'),
});

interface LoginForm {
  email: string;
  password: string;
}

export const LoginScreen: React.FC = () => {
  const [formData, setFormData] = useState<LoginForm>({
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<Partial<LoginForm>>({});

  const handleSubmit = async () => {
    try {
      // Validate
      await loginSchema.validate(formData, { abortEarly: false });
      setErrors({});

      // Submit form
      console.log('Form valid:', formData);
    } catch (error) {
      if (error instanceof Yup.ValidationError) {
        const validationErrors: Partial<LoginForm> = {};
        error.inner.forEach(err => {
          if (err.path) {
            validationErrors[err.path as keyof LoginForm] = err.message;
          }
        });
        setErrors(validationErrors);
      }
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={[styles.input, errors.email && styles.inputError]}
        placeholder="Email"
        value={formData.email}
        onChangeText={(text) => setFormData({ ...formData, email: text })}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      {errors.email && <Text style={styles.error}>{errors.email}</Text>}

      <TextInput
        style={[styles.input, errors.password && styles.inputError]}
        placeholder="Password"
        value={formData.password}
        onChangeText={(text) => setFormData({ ...formData, password: text })}
        secureTextEntry
      />
      {errors.password && <Text style={styles.error}>{errors.password}</Text>}

      <Button title="Login" onPress={handleSubmit} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    fontSize: 16,
  },
  inputError: {
    borderColor: '#ef4444',
  },
  error: {
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 12,
  },
});
```

### Complex Validation Schema

```typescript
const registrationSchema = Yup.object().shape({
  username: Yup.string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .required('Username is required'),

  email: Yup.string()
    .email('Invalid email address')
    .required('Email is required'),

  password: Yup.string()
    .min(8, 'Password must be at least 8 characters')
    .matches(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .matches(/[a-z]/, 'Password must contain at least one lowercase letter')
    .matches(/[0-9]/, 'Password must contain at least one number')
    .required('Password is required'),

  confirmPassword: Yup.string()
    .oneOf([Yup.ref('password')], 'Passwords must match')
    .required('Please confirm your password'),

  age: Yup.number()
    .min(18, 'You must be at least 18 years old')
    .required('Age is required'),

  terms: Yup.boolean()
    .oneOf([true], 'You must accept the terms and conditions')
    .required(),
});
```

---

## Form Hooks

### useForm Hook

```typescript
import { useState, useCallback } from 'react';
import * as Yup from 'yup';

interface UseFormOptions<T> {
  initialValues: T;
  validationSchema: Yup.ObjectSchema<T>;
  onSubmit: (values: T) => void | Promise<void>;
}

export function useForm<T extends Record<string, unknown>>({
  initialValues,
  validationSchema,
  onSubmit,
}: UseFormOptions<T>) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = useCallback((field: keyof T, value: unknown) => {
    setValues(prev => ({ ...prev, [field]: value }));
    // Clear error for this field
    setErrors(prev => ({ ...prev, [field]: undefined }));
  }, []);

  const handleSubmit = useCallback(async () => {
    try {
      setIsSubmitting(true);
      // Validate
      await validationSchema.validate(values, { abortEarly: false });
      setErrors({});

      // Submit
      await onSubmit(values);
    } catch (error) {
      if (error instanceof Yup.ValidationError) {
        const validationErrors: Partial<Record<keyof T, string>> = {};
        error.inner.forEach(err => {
          if (err.path) {
            validationErrors[err.path as keyof T] = err.message;
          }
        });
        setErrors(validationErrors);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [values, validationSchema, onSubmit]);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
  }, [initialValues]);

  return {
    values,
    errors,
    isSubmitting,
    handleChange,
    handleSubmit,
    reset,
  };
}

// Usage
const loginSchema = Yup.object().shape({
  email: Yup.string().email().required(),
  password: Yup.string().min(8).required(),
});

export const LoginScreen: React.FC = () => {
  const { values, errors, isSubmitting, handleChange, handleSubmit } = useForm({
    initialValues: { email: '', password: '' },
    validationSchema: loginSchema,
    onSubmit: async (values) => {
      console.log('Submitting:', values);
    },
  });

  return (
    <View style={styles.container}>
      <TextInput
        placeholder="Email"
        value={values.email}
        onChangeText={(text) => handleChange('email', text)}
      />
      {errors.email && <Text style={styles.error}>{errors.email}</Text>}

      <TextInput
        placeholder="Password"
        value={values.password}
        onChangeText={(text) => handleChange('password', text)}
        secureTextEntry
      />
      {errors.password && <Text style={styles.error}>{errors.password}</Text>}

      <Button
        title={isSubmitting ? 'Submitting...' : 'Login'}
        onPress={handleSubmit}
        disabled={isSubmitting}
      />
    </View>
  );
};
```

---

## Common Patterns

### Reusable Input Component

```typescript
interface FormInputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad';
}

export const FormInput: React.FC<FormInputProps> = ({
  label,
  value,
  onChangeText,
  error,
  placeholder,
  secureTextEntry,
  keyboardType = 'default',
}) => (
  <View style={styles.inputContainer}>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      style={[styles.input, error && styles.inputError]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      autoCapitalize="none"
    />
    {error && <Text style={styles.error}>{error}</Text>}
  </View>
);

const styles = StyleSheet.create({
  inputContainer: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    color: '#374151',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  inputError: {
    borderColor: '#ef4444',
  },
  error: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 4,
  },
});
```

### Checkbox Field

```typescript
interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  error?: string;
}

export const CheckboxField: React.FC<CheckboxFieldProps> = ({
  label,
  checked,
  onToggle,
  error,
}) => (
  <View style={styles.checkboxContainer}>
    <Pressable onPress={onToggle} style={styles.checkboxRow}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked && <Ionicons name="checkmark" size={16} color="#fff" />}
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </Pressable>
    {error && <Text style={styles.error}>{error}</Text>}
  </View>
);
```

### Real-time Validation

```typescript
export const EmailInput: React.FC = () => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const validateEmail = useCallback(
    debounce(async (value: string) => {
      try {
        await Yup.string().email().required().validate(value);
        setError('');
      } catch (err) {
        if (err instanceof Yup.ValidationError) {
          setError(err.message);
        }
      }
    }, 500),
    []
  );

  const handleChange = (text: string) => {
    setEmail(text);
    validateEmail(text);
  };

  return (
    <FormInput
      label="Email"
      value={email}
      onChangeText={handleChange}
      error={error}
      keyboardType="email-address"
    />
  );
};
```

---

## Best Practices

1. **Clear Errors on Change**: Clear field errors when user starts typing
2. **Validation on Blur**: Validate fields when user leaves input
3. **Submit Validation**: Always validate entire form on submit
4. **Loading States**: Disable submit button while submitting
5. **Error Messages**: Show clear, actionable error messages
6. **TypeScript**: Use proper types for form data and errors
7. **Accessibility**: Add proper labels and error announcements
8. **Keyboard Handling**: Use appropriate keyboard types
