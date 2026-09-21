class InvoicesController < ApplicationController
  layout "application"

  def index
    @invoices = Invoice.all
  end
end
