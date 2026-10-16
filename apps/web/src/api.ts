import axios from 'axios';
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000/api/v1' : '/api/v1'), withCredentials: true });
export type User = { id: string; name: string; email: string; role: 'ADMIN' | 'STUDENT' | 'INVIGILATOR' | 'HOD'; departmentId: string | null };
