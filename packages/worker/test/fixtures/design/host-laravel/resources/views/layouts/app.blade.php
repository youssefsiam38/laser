<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="/css/app.css" />
  </head>
  <body>
    <header class="site-header">
      <h1>Ledger</h1>
    </header>
    <nav class="site-nav">
      <ul>
        <li><a href="/orders">Orders</a></li>
      </ul>
    </nav>
    <main class="container">
      @yield('content')
    </main>
    <footer class="site-footer">© Ledger</footer>
  </body>
</html>
