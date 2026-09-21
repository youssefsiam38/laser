@extends('layouts.app')

@section('content')
  <section class="orders">
    <h2>Orders</h2>
    @include('partials.filters')
    <table class="orders-table">
      <tbody>
        @foreach ($orders as $order)
          <x-order-row :order="$order" />
        @endforeach
      </tbody>
    </table>
  </section>
@endsection
