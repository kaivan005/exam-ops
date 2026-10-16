import axios from 'axios';
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');
const apiBaseUrl = configuredApiUrl ? (configuredApiUrl.endsWith('/api/v1') ? configuredApiUrl : `${configuredApiUrl}/api/v1`) : (import.meta.env.DEV ? 'http://localhost:4000/api/v1' : '/api/v1');
export const api = axios.create({ baseURL: apiBaseUrl, withCredentials: true });
api.interceptors.response.use((response) => {
	const token = response.headers['x-csrf-token'];
	if (token) api.defaults.headers.common['X-CSRF-Token'] = token;
	return response;
}, (error) => {
	const token = error.response?.headers?.['x-csrf-token'];
	if (token) api.defaults.headers.common['X-CSRF-Token'] = token;
	return Promise.reject(error);
});
export type User = { id: string; name: string; email: string; role: 'ADMIN' | 'STUDENT' | 'INVIGILATOR' | 'HOD'; departmentId: string | null };
