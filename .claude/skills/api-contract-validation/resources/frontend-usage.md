# Frontend & Website API Contract Usage

## Frontend Usage (React Native / Expo)

**File**: `frontend/src/services/user/userService.ts`

```typescript
import {
  CreateUserRequest,
  CreateUserResponse,
  UpdateUserRequest,
  UpdateUserResponse,
  GetUserResponse,
  ListUsersRequest,
  ListUsersResponse
} from '@stewra/shared-types';
import { apiClient } from '@/utils/apiClient';

export class UserService {
  private baseUrl = '/users';

  async createUser(data: CreateUserRequest): Promise<CreateUserResponse> {
    const response = await apiClient.post<CreateUserResponse>(
      this.baseUrl,
      data
    );
    return response.data;
  }

  async updateUser(userId: number, data: Omit<UpdateUserRequest, 'userId'>): Promise<UpdateUserResponse> {
    const response = await apiClient.put<UpdateUserResponse>(
      `${this.baseUrl}/${userId}`,
      data
    );
    return response.data;
  }

  async getUser(userId: number): Promise<GetUserResponse> {
    const response = await apiClient.get<GetUserResponse>(
      `${this.baseUrl}/${userId}`
    );
    return response.data;
  }

  async getUserByUsername(username: string): Promise<GetUserResponse> {
    const response = await apiClient.get<GetUserResponse>(
      `${this.baseUrl}?username=${encodeURIComponent(username)}`
    );
    return response.data;
  }

  async listUsers(params: ListUsersRequest): Promise<ListUsersResponse> {
    const queryParams = new URLSearchParams();

    if (params.page) queryParams.set('page', params.page.toString());
    if (params.pageSize) queryParams.set('pageSize', params.pageSize.toString());
    if (params.search) queryParams.set('search', params.search);
    if (params.sortBy) queryParams.set('sortBy', params.sortBy);
    if (params.sortOrder) queryParams.set('sortOrder', params.sortOrder);

    const response = await apiClient.get<ListUsersResponse>(
      `${this.baseUrl}?${queryParams.toString()}`
    );
    return response.data;
  }
}

export const userService = new UserService();
```

### Using in React Components

```typescript
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList } from 'react-native';
import { userService } from '@/services/user/userService';
import type { User, ListUsersRequest } from '@stewra/shared-types';

export const UserListScreen: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const params: ListUsersRequest = {
        page: 1,
        pageSize: 20,
        sortBy: 'username',
        sortOrder: 'asc'
      };

      const response = await userService.listUsers(params);
      setUsers(response.users);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View>
      <FlatList
        data={users}
        keyExtractor={(item) => item.userId.toString()}
        renderItem={({ item }) => (
          <Text>{item.username}</Text>
        )}
      />
    </View>
  );
};
```

## Website Usage (Next.js)

**File**: `website/src/services/userService.ts`

```typescript
import {
  GetUserResponse,
  ListUsersRequest,
  ListUsersResponse,
  User
} from '@stewra/shared-types';
import { fetchApi } from '@/utils/fetch';

export class UserService {
  private baseUrl = '/api/users';

  async getUser(userId: number): Promise<User> {
    const response = await fetchApi<GetUserResponse>(
      `${this.baseUrl}/${userId}`
    );
    return response.user;
  }

  async listUsers(params: ListUsersRequest): Promise<ListUsersResponse> {
    const queryParams = new URLSearchParams();

    if (params.page) queryParams.set('page', params.page.toString());
    if (params.pageSize) queryParams.set('pageSize', params.pageSize.toString());
    if (params.search) queryParams.set('search', params.search);

    const response = await fetchApi<ListUsersResponse>(
      `${this.baseUrl}?${queryParams.toString()}`
    );
    return response;
  }
}

export const userService = new UserService();
```

### Using in Next.js Components

```typescript
import { useEffect, useState } from 'react';
import { userService } from '@/services/userService';
import type { User, ListUsersRequest } from '@stewra/shared-types';

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const params: ListUsersRequest = {
        page: 1,
        pageSize: 20
      };

      const response = await userService.listUsers(params);
      setUsers(response.users);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {users.map(user => (
        <div key={user.userId}>{user.username}</div>
      ))}
    </div>
  );
}
```

## Best Practices for Frontend/Website

1. **Always import types from @stewra/shared-types**
   ```typescript
   import type { User, CreateUserRequest } from '@stewra/shared-types';
   ```

2. **Type service method parameters and returns**
   ```typescript
   async createUser(data: CreateUserRequest): Promise<CreateUserResponse>
   ```

3. **Use shared types in component state**
   ```typescript
   const [users, setUsers] = useState<User[]>([]);
   ```

4. **Type API responses explicitly**
   ```typescript
   const response = await apiClient.get<GetUserResponse>('/users/1');
   ```

5. **Build type-safe query parameters**
   ```typescript
   const params: ListUsersRequest = { page: 1, pageSize: 20 };
   ```
