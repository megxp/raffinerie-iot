from django.urls import path
from . import views

urlpatterns = [
    path('',                   views.dashboard,           name='dashboard'),
    path('api/start/',         views.start_pipeline,      name='start'),
    path('api/stop/',          views.stop_pipeline,       name='stop'),
    path('api/config/',        views.update_config,       name='update_config'),
    path('api/restart-sim/',   views.restart_simulateur,  name='restart_sim'),
    path('api/status/',        views.status_api,          name='status'),
    path('api/donnees/',       views.donnees_api,         name='donnees'),
]
