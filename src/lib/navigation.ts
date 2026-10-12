// Keep full-page navigation separate so DOM tests can replace it safely.
export const navigation = {
  toLogin() {
    if (window.location.pathname !== '/login') window.location.replace('/login')
  },
}
